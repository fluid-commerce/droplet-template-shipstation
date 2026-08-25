import { tokenDigest } from "./signatures";
import { consoleLogger, describeError, type Logger } from "./redact";
import type { CallbackTokenStore } from "./store/types";

/**
 * The subset of a Fluid client this backfill needs.
 *
 * Structural so it works with each droplet's own copy of FluidClient — there
 * are 21 divergent versions in the monorepo and this must not depend on any
 * one of them.
 */
export interface CallbackListingClient {
  /**
   * `GET /api/callback/registrations`.
   *
   * The params are optional so this stays structurally compatible with the
   * fleet's existing zero-argument `listCallbacks()` copies — but a client that
   * ignores them caps the backfill at Fluid's default page size, so prefer one
   * that forwards them.
   */
  listCallbacks(params?: { page?: number; per_page?: number }): Promise<{
    callback_registrations: Array<{
      uuid: string;
      definition_name: string;
      url: string;
      verification_token?: string;
    }>;
  }>;
}

/**
 * Fluid's index action defaults to `per_page: 10`. Ask for more per request,
 * but still page — asking is not the same as receiving, and a droplet with more
 * registrations than one page would otherwise be backfilled only in part and
 * then reject the remainder once enforcing.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export interface BackfillResult {
  stored: number;
  skipped: number;
  /** definition_name values whose registration carried no token. */
  missingToken: string[];
  /** Registrations belonging to a different droplet, skipped. */
  foreign: number;
}

/**
 * Populates the callback token store for an installation that predates the SDK.
 *
 * Fluid returns `verification_token` on the `api_index` view as well as on
 * create, so existing registrations can be adopted without re-registering and
 * without a reinstall.
 *
 * Until this has run, an install has no stored tokens, every callback lookup
 * misses, and `enforce` mode would reject everything. Run it before enforcing.
 *
 * ## Why `dropletUrl` matters
 *
 * `GET /api/callback/registrations` is scoped to the **company**, not to the
 * installation — it lists every registration the company has, including those
 * owned by other droplets, and exposes no owner filter. Adopting all of them
 * would stamp another droplet's registrations with this droplet's `dri`, so
 * `deleteForInstallation` would later delete rows that were never ours; and
 * where two droplets serve the same definition name, the other droplet's token
 * would then verify at our route.
 *
 * `owner_id` cannot be used to tell them apart — the blueprint renders it as a
 * numeric id for a DropletInstallation, not the `dri_` slug. The registration
 * `url` is the discriminator a droplet can actually check, since it knows its
 * own public URL.
 *
 * ## Why origin alone is not enough
 *
 * An earlier version compared parsed origins — which correctly rejects the
 * `https://ours.example.com.attacker.tld` prefix trap, but accepts ANY path on
 * our host. A second droplet installed for the same company could register one
 * of our definitions at `https://ours.example.com/not-a-route-we-serve`, keep
 * the token Fluid returned, and we would adopt it: the wrapper matches on
 * `definitionName`, not on url, so that token would then verify at our real
 * route.
 *
 * So `ownUrls` is matched exactly, the same way `cleanupCallbacks` already
 * decides what it is allowed to delete. Pass the full URLs this droplet
 * registers — `${FLUID_DROPLET_URL}${callback.url}` for each configured
 * callback.
 */
export async function backfillCallbackTokens({
  client,
  store,
  dri,
  dropletUrl,
  ownUrls,
  logger = consoleLogger,
}: {
  client: CallbackListingClient;
  store: CallbackTokenStore;
  dri: string;
  /**
   * This droplet's public base URL (`FLUID_DROPLET_URL`).
   *
   * Required, and validated: without it there is no way to tell our
   * registrations from another droplet's, and defaulting to "adopt everything"
   * would hand us their tokens. An absent value is a misconfiguration, so it
   * throws rather than quietly adopting the lot.
   */
  dropletUrl: string;
  /**
   * The exact callback URLs this droplet registers. Only registrations whose
   * url is in this set are adopted.
   *
   * Optional for now so existing callers keep working, but omitting it falls
   * back to origin-only matching, which cannot tell our registration from a
   * co-installed droplet's registration on the same host. Supply it.
   */
  ownUrls?: string[];
  logger?: Logger;
}): Promise<BackfillResult> {
  const ownOrigin = originOf(dropletUrl);
  if (!ownOrigin) {
    throw new Error(
      "backfillCallbackTokens requires dropletUrl (FLUID_DROPLET_URL) to be a valid absolute URL; " +
        "without it, another droplet's registrations cannot be told apart from ours",
    );
  }

  const ownUrlSet = ownUrls && ownUrls.length > 0 ? new Set(ownUrls) : null;
  if (!ownUrlSet) {
    logger.warn(
      "[backfill] ownUrls not supplied; falling back to origin-only matching, " +
        "which cannot distinguish a co-installed droplet registering one of our " +
        "definitions on this same host",
    );
  }

  const result: BackfillResult = {
    stored: 0,
    skipped: 0,
    missingToken: [],
    foreign: 0,
  };

  type Registration = Awaited<
    ReturnType<CallbackListingClient["listCallbacks"]>
  >["callback_registrations"][number];

  const registrations: Registration[] = [];
  const seen = new Set<string>();

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch =
        (await client.listCallbacks({ page, per_page: PAGE_SIZE }))
          .callback_registrations ?? [];

      // A client that drops the params returns page 1 forever. Detecting the
      // repeat is what stops that becoming an infinite loop.
      const fresh = batch.filter((r) => !seen.has(r.uuid));
      fresh.forEach((r) => seen.add(r.uuid));
      registrations.push(...fresh);

      // Deliberately not `batch.length < PAGE_SIZE`: Fluid caps per_page at
      // 100 today, but a lower cap — or a client that drops the params — would
      // make every page look like the last one and silently truncate. Stop only
      // on a genuinely empty page, or when a page adds nothing new (which is
      // what a params-ignoring client produces on its second call).
      if (batch.length === 0 || fresh.length === 0) break;

      if (page === MAX_PAGES) {
        logger.warn(
          "[backfill] stopped at the page limit; some registrations may not be stored",
          { pages: MAX_PAGES, collected: registrations.length },
        );
      }
    }
  } catch (error) {
    logger.error(
      "[backfill] could not list callback registrations",
      describeError(error),
    );
    throw error;
  }

  for (const registration of registrations) {
    // Another droplet's registration, listed only because the endpoint is
    // company-scoped. Adopting it would give us its token and put our dri on
    // its row.
    //
    // Exact url when we were told our own urls; origin as the weaker fallback
    // otherwise. Never a string prefix: `startsWith` on
    // "https://rewards.example.com" also matches
    // "https://rewards.example.com.attacker.tld".
    const ours = ownUrlSet
      ? ownUrlSet.has(registration.url)
      : originOf(registration.url) === ownOrigin;
    if (!ours) {
      result.foreign++;
      continue;
    }

    if (!registration.verification_token || !registration.uuid) {
      result.skipped++;
      result.missingToken.push(registration.definition_name);
      continue;
    }

    await store.upsert({
      uuid: registration.uuid,
      dri,
      definitionName: registration.definition_name,
      tokenDigest: tokenDigest(registration.verification_token),
      url: registration.url,
    });
    result.stored++;
  }

  if (result.missingToken.length > 0) {
    // The one case that forces re-registration rather than adoption.
    logger.warn(
      "[backfill] registrations returned without a verification_token; these cannot be verified until re-registered",
      { definitions: result.missingToken },
    );
  }

  logger.info("[backfill] complete", {
    stored: result.stored,
    skipped: result.skipped,
    foreign: result.foreign,
  });

  return result;
}

/**
 * The origin of a URL, or null if it is not a parseable absolute URL.
 *
 * Ownership is an origin comparison, not a string comparison — see the call
 * site for why prefix matching is unsafe here.
 */
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

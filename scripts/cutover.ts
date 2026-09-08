/**
 * Moves ONE company's Fluid webhook registrations between the Rails app and the
 * Next app, and reports whether doing so would keep that company's orders
 * flowing.
 *
 * Both commands need to know where the registrations are NOW (`--from`) as well
 * as where they should go (`--url`), and the route (`--webhook-path`), because
 * the two apps do not agree on any of the three.
 *
 *   pnpm cutover status <fluid_shop> \
 *     --from https://fluid-droplet-shipstation-....run.app \
 *     --url  https://fluid-droplet-shipstation-next-....run.app
 *
 *   APPLY=1 pnpm cutover repoint <fluid_shop> \
 *     --from https://fluid-droplet-shipstation-....run.app \
 *     --url  https://fluid-droplet-shipstation-next-....run.app \
 *     --webhook-path /api/webhooks
 *
 * Rollback is the same command with --from and --url swapped, carrying Rails's
 * own path:
 *
 *   APPLY=1 pnpm cutover repoint <fluid_shop> \
 *     --from https://fluid-droplet-shipstation-next-....run.app \
 *     --url  https://fluid-droplet-shipstation-....run.app \
 *     --webhook-path /webhook
 *

 * ## Why this droplet's cutover is different from its siblings'
 *
 * Every other ported droplet cuts over CALLBACKS: synchronous, on the checkout
 * path, verified by a per-registration token this app has to store a digest of.
 * That is what scripts/cutover.ts does in those repos, and most of its length is
 * token bookkeeping.
 *
 * This droplet registers NO callbacks (src/lib/config/droplet.config.ts, and
 * there is no src/app/api/callbacks route). Everything it receives is a webhook:
 * asynchronous, retried by Fluid, and verified against a token that already
 * lives on the `companies` row. So there is no token to create, persist or
 * reconcile — a repoint is purely a url move, and the failure mode is "orders
 * stop syncing", which is visible and replayable, rather than "shopper sees the
 * wrong number".
 *
 * ## The one thing that can silently break, and the guard for it
 *
 * From fluid's own `app/models/webhook.rb`:
 *
 *     def auth_token
 *       droplet_installation&.webhook_verification_token || super
 *     end
 *
 * So fluid signs a webhook with the INSTALLATION's `webhook_verification_token`
 * when the webhook is linked to a droplet installation, and falls back to the
 * webhook's own stored `auth_token` when it is not.
 *
 * src/app/api/webhooks/route.ts mirrors exactly that: `resolve()` returns the
 * company's `webhook_verification_token`, and the shared bootstrap secret is
 * accepted ONLY for `droplet.installed` / `droplet.uninstalled`.
 *
 * The two halves agree — except for a company we hold no
 * `webhook_verification_token` for. Rails did not need one: it compared a
 * plaintext AUTH_TOKEN header against the SHARED token, so it accepted those
 * deliveries happily. This app cannot. Repoint such a company and every
 * `order.created` and `order.updated` starts returning 401 while Rails, which
 * would have accepted them, no longer receives them.
 *
 * That is not hypothetical. At the time of writing, company 980191006 (the
 * internal `fluid.fluid.app` install) has three webhooks with
 * `droplet_installation_id` NULL, and no `webhook_verification_token` on its
 * `companies` row.
 *
 * `repoint` therefore refuses to move a NON-BOOTSTRAP webhook for a company
 * whose token we do not hold. Bootstrap webhooks (`droplet.*`) are moved
 * regardless, because those genuinely do verify against the shared secret.
 *
 * ## Why the auth_token is re-sent on update
 *
 * `PUT /api/company/webhooks/:id` validates against the same schema as create,
 * so `auth_token` is required, and the listing does not return the current one
 * — it cannot be read back and preserved. FLUID_WEBHOOK_AUTH_TOKEN is sent,
 * which is the same value install-time registration sends
 * (src/lib/handlers/droplet-installed.ts). Per the `auth_token` override above
 * this does not change the signing key for any webhook linked to an
 * installation, and for the bootstrap pair the shared secret is exactly the key
 * that must be there.
 *
 * Writes require APPLY=1. `status` never writes.
 */

import { createHmac } from "node:crypto";

import { prisma } from "@/lib/db";
import { createFluidClient, type FluidClient } from "@/lib/fluid";
import { dropletConfig } from "@/lib/config";
import {
  normaliseOrigin as normaliseOriginOrThrow,
  normalisePath as normalisePathOrThrow,
  CutoverUrlError,
} from "@/lib/cutover/urls";

const APPLY = process.env.APPLY === "1";

/**
 * The two paths a webhook of ours can be registered at.
 *
 * Rails serves `POST /webhook` (config/routes.rb); this app serves
 * `POST /api/webhooks`. Both are in the recognition set, because a first
 * cutover finds every webhook on the Rails path and a rollback finds them all
 * on the Next one. Looking for only one path means the run matches nothing,
 * reports success, and leaves production where it was.
 */
const NEXT_WEBHOOK_PATH = "/api/webhooks";
const RAILS_WEBHOOK_PATH = "/webhook";
const WEBHOOK_PATHS = [NEXT_WEBHOOK_PATH, RAILS_WEBHOOK_PATH];

/**
 * The events fluid signs with the SHARED secret rather than a company's own
 * token — the EXACT pairs, not the resource.
 *
 * Kept identical to BOOTSTRAP_EVENTS in src/app/api/webhooks/route.ts, which
 * lists `droplet.installed` and `droplet.uninstalled` and nothing else.
 *
 * Matching on `resource === "droplet"` alone was wrong and reachable: a
 * `droplet.updated` subscription would be classified bootstrap, so the
 * token guard below would wave it through for a company we hold no
 * verification token for — and the route would then 401 every delivery,
 * because it accepts the shared secret only for the two events above.
 */
const BOOTSTRAP_EVENTS = new Set(["droplet.installed", "droplet.uninstalled"]);
const BOOTSTRAP_RESOURCE = "droplet";

type FluidWebhook = {
  id: number | string;
  resource?: string;
  event?: string;
  url?: string;
  active?: boolean;
};

function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/**
 * The url helpers live in src/lib/cutover/urls.ts so they can be TESTED — this
 * file calls main() at import, so a test importing it would run the tool.
 * They throw; here that becomes an exit.
 */
function normaliseOrigin(value: string, flag: string): string {
  try {
    return normaliseOriginOrThrow(value, flag);
  } catch (error) {
    if (error instanceof CutoverUrlError) fail(error.message);
    throw error;
  }
}

function normalisePath(value: string, flag: string): string {
  try {
    return normalisePathOrThrow(value, flag);
  } catch (error) {
    if (error instanceof CutoverUrlError) fail(error.message);
    throw error;
  }
}


/**
 * The configured subscriptions this company is NOT ready to serve.
 *
 * Shared by status and repoint on purpose. status is the command an operator
 * uses to decide whether a company can be cut over, so it has to predict
 * repoint's verdict — it used to print "N webhook(s) would be repointed" while
 * repoint went on to refuse the same company outright.
 *
 * `missing` is a configured event fluid holds no registration of ours for.
 * `dead` is one registered with `active: false`: the row exists and delivers
 * nothing, and repoint preserves the flag, so moving it would verify a url and
 * report a cutover while that event still reached nobody. The two are reported
 * separately because the remedies differ — re-register versus re-activate.
 */
function completenessProblems(ours: FluidWebhook[]): {
  missing: string[];
  dead: string[];
} {
  const enabled = dropletConfig.webhooks.filter((w) => w.enabled !== false);
  const nonBootstrap = ours.filter((w) => !isBootstrap(w));
  const live = new Set(
    nonBootstrap
      .filter((w) => w.active !== false)
      .map((w) => `${w.resource}.${w.event}`),
  );
  const inactive = new Set(
    nonBootstrap
      .filter((w) => w.active === false)
      .map((w) => `${w.resource}.${w.event}`),
  );
  const absent = enabled
    .map((w) => `${w.resource}.${w.event}`)
    .filter((name) => !live.has(name));

  return {
    missing: absent.filter((name) => !inactive.has(name)),
    dead: absent.filter((name) => inactive.has(name)),
  };
}

/** The operator-facing text for completenessProblems, shared by both commands. */
function describeCompleteness(missing: string[], dead: string[]): string {
  return (
    (missing.length > 0
      ? `  fluid holds no registration of ours for: ${missing.join(", ")}.\n` +
        `  Install-time registration failures are logged and swallowed, so this\n` +
        `  is a state a live company can genuinely be in. Re-register first.\n\n`
      : "") +
    (dead.length > 0
      ? `  Registered but INACTIVE: ${dead.join(", ")}.\n` +
        `  Those rows exist and deliver nothing, and repoint preserves the\n` +
        `  active flag — so moving them would verify their url and report the\n` +
        `  tenant cut over while the event still reaches nobody. Re-activate\n` +
        `  them first.\n\n`
      : "")
  );
}

async function loadCompany(handle: string) {
  const company = await prisma.company.findFirst({
    where: {
      OR: [
        { fluidShop: handle },
        { fluidCompanyId: /^\d+$/.test(handle) ? BigInt(handle) : BigInt(-1) },
      ],
    },
  });
  if (!company) fail(`No company matches "${handle}".`);
  return company;
}

/**
 * Whether a listed webhook is one of OURS.
 *
 * The listing is COMPANY-scoped, not droplet-scoped: another droplet installed
 * for the same company appears in it, subscribed to the same resource+event.
 * So the url is the discriminator and the resource+event is the filter — never
 * resource+event alone.
 *
 * `origins` is every host a webhook of ours could currently be at: the Rails
 * service and the Next service. A repoint from one to the other has to
 * recognise both, and passing only the destination would match nothing on a
 * first run.
 */
function isOurs(webhook: FluidWebhook, origins: string[]): boolean {
  if (!webhook.url) return false;
  const expected = origins.flatMap((origin) =>
    WEBHOOK_PATHS.map((path) => `${origin}${path}`),
  );
  if (!expected.includes(webhook.url)) return false;

  if (webhook.resource === BOOTSTRAP_RESOURCE) return true;

  return dropletConfig.webhooks
    .filter((w) => w.enabled !== false)
    .some((w) => w.resource === webhook.resource && w.event === webhook.event);
}

function isBootstrap(webhook: FluidWebhook): boolean {
  return BOOTSTRAP_EVENTS.has(`${webhook.resource}.${webhook.event}`);
}

/**
 * Every webhook fluid holds for this company, paged to the end.
 *
 * Delegates to the client's `listAllWebhooks` rather than paging here, so the
 * cutover tool and the uninstall cleanup cannot drift on this. A bare
 * `listWebhooks()` returns 30, and the listing is COMPANY-scoped: an active
 * company carries a webhook for every droplet it has installed. fluid.fluid.app
 * has 39. An unpaged call silently omitted an `order.created` of ours, and a
 * repoint would have moved two webhooks of three, verified the two it knew
 * about, and reported success.
 */
async function listWebhooks(client: FluidClient): Promise<FluidWebhook[]> {
  return (await client.listAllWebhooks()) as FluidWebhook[];
}

/** Reads `--flag value` out of argv, or returns undefined. */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} needs a value.`);
  return value;
}

function describe(webhook: FluidWebhook): string {
  return `${webhook.resource ?? "?"}.${webhook.event ?? "?"}`;
}

async function status(handle: string, args: string[]) {
  const company = await loadCompany(handle);
  const client = createFluidClient(company.authenticationToken);

  // Both origins come from flags, like repoint's. Falling back to
  // FLUID_DROPLET_URL meant that from a clean shell — which is what
  // db-connect.sh --exec gives you — status searched only the destination,
  // found nothing of ours, and printed "0 webhook(s) would be repointed".
  //
  // That is worse than repoint's version of the same bug. repoint exited
  // non-zero and said it had matched nothing; status returned a NUMBER, and a
  // wrong number reads as an answer.
  const destination = flag(args, "--url");
  const source = flag(args, "--from");
  const origins = [
    destination ? normaliseOrigin(destination, "--url") : null,
    source ? normaliseOrigin(source, "--from") : null,
  ].filter((value): value is string => value !== null);

  const webhooks = await listWebhooks(client);
  const holdsToken = !!company.webhookVerificationToken;

  console.log(
    `Company ${company.fluidShop} (id ${company.id}, fluid ${company.fluidCompanyId})`,
  );
  console.log(`  droplet_installation_uuid: ${company.dropletInstallationUuid ?? "MISSING"}`);
  console.log(`  webhook_verification_token held: ${holdsToken ? "yes" : "NO"}`);
  console.log(`\nFluid holds ${webhooks.length} webhook(s) for this company:\n`);

  for (const webhook of webhooks) {
    const ours = origins.length > 0 && isOurs(webhook, origins);
    // Printed even when it is not ours: a webhook at an origin we did not pass
    // is exactly what a half-finished cutover looks like, and hiding it is how
    // the last one got missed.
    const mark = ours ? "ours" : "    ";
    console.log(`  ${mark}  ${describe(webhook).padEnd(22)} ${webhook.url ?? "(no url)"}`);
  }

  if (origins.length === 0) {
    console.log(
      `\nNo --from or --url given, so nothing could be matched as ours — the\n` +
        `list above is every webhook this company has, unannotated.\n\n` +
        `  Re-run with --from <where they are now> and --url <destination> to\n` +
        `  see which are ours and what repoint would move.`,
    );
    return;
  }

  const ours = webhooks.filter((w) => isOurs(w, origins));
  const blocked = ours.filter((w) => !isBootstrap(w) && !holdsToken);
  const { missing, dead } = completenessProblems(ours);

  // What repoint WOULD do, not merely what matched.
  //
  // This used to print "N webhook(s) would be repointed" from the match count
  // alone, so a company repoint goes on to refuse — one with order.updated
  // missing or inactive — was reported as ready to move. status is the command
  // an operator uses to decide, so it has to give repoint's answer.
  const wouldRefuse =
    blocked.length > 0 || missing.length > 0 || dead.length > 0;

  console.log(
    wouldRefuse
      ? `\n${ours.length} webhook(s) matched, but repoint would REFUSE this company.`
      : `\n${ours.length} webhook(s) would be repointed.`,
  );

  if (missing.length > 0 || dead.length > 0) {
    console.log("\n" + describeCompleteness(missing, dead).trimEnd());
  }

  if (blocked.length > 0) {
    console.log(
      `\nREFUSED: ${blocked.length} of them (${blocked
        .map(describe)
        .join(", ")}) ${blocked.length === 1 ? "is" : "are"} not a bootstrap ` +
        `event, and this company has no stored ` +
        `webhook_verification_token.\n\n` +
        `  Fluid signs those with the installation's verification token, and ` +
        `this app verifies against the copy on the companies row. We do not ` +
        `have it, so every one of them would come back 401 — while Rails, ` +
        `which authenticated them against the SHARED token and accepted them, ` +
        `would no longer be receiving them. The orders would simply stop.\n\n` +
        `  Fix it by reinstalling the droplet for this company, which delivers ` +
        `the token in the droplet.installed payload. Then re-run status.`,
    );
  }
}

async function repoint(handle: string, args: string[]) {
  const destination = flag(args, "--url");
  if (!destination) fail("repoint needs --url <destination base url>.");
  const target = normaliseOrigin(destination, "--url");
  // REQUIRED, with no default.
  //
  // It used to default to this app's `/api/webhooks`, which quietly broke the
  // documented rollback: `repoint <shop> --url https://<rails>` then wrote
  // `https://<rails>/api/webhooks`, a route Rails does not have — it serves
  // `post "webhook"` (config/routes.rb). The update would report success, and
  // every subsequent delivery would 404 behind Fluid's retry.
  //
  // The two apps do not agree on the path, so the path cannot be inferred from
  // the host without encoding a guess about which app lives there. State it.
  const pathFlag = flag(args, "--webhook-path");
  if (!pathFlag) {
    fail(
      `repoint needs --webhook-path.\n\n` +
        `  This app serves ${NEXT_WEBHOOK_PATH}; Rails serves ${RAILS_WEBHOOK_PATH}.\n` +
        `  There is no safe default: defaulting to either one silently writes a\n` +
        `  url the other app does not serve, and the update still reports success.\n\n` +
        `  cut over:  --url <next-service>  --webhook-path ${NEXT_WEBHOOK_PATH}\n` +
        `  roll back: --url <rails-service> --webhook-path ${RAILS_WEBHOOK_PATH}`,
    );
  }
  const path = normalisePath(pathFlag, "--webhook-path");
  if (!WEBHOOK_PATHS.includes(path)) {
    fail(
      `--webhook-path must be one of ${WEBHOOK_PATHS.join(" or ")}; got "${path}".\n\n` +
        `  These are the only two routes either app serves. A near miss —\n` +
        `  "/api/webhook" for "/api/webhooks" — is accepted by fluid, stored,\n` +
        `  and reads back exactly as requested, so every check downstream of\n` +
        `  the write passes while deliveries 404.`,
    );
  }
  const targetUrl = `${target}${path}`;

  const sharedToken = process.env.FLUID_WEBHOOK_AUTH_TOKEN;
  const authToken = sharedToken;
  if (!authToken) {
    fail(
      `FLUID_WEBHOOK_AUTH_TOKEN is not set. The update endpoint validates ` +
        `against the create schema, so auth_token is required and the listing ` +
        `does not return the current one. Refusing to send an empty token, ` +
        `which would leave the bootstrap webhooks unverifiable.`,
    );
  }

  const company = await loadCompany(handle);
  const client = createFluidClient(company.authenticationToken);

  // Every origin a webhook of ours could be sitting at right now: the
  // destination (already cut over, or a re-run) and wherever this deployment
  // thinks it lives. Without the second, a first cutover from Rails matches
  // nothing and exits zero having moved nothing.
  // --from is REQUIRED. It names where the registrations are NOW.
  //
  // It used to fall back to FLUID_DROPLET_URL, and db-connect.sh --exec does
  // not supply that — so from a clean shell the documented command searched
  // only the destination, matched nothing, and exited. It failed safe (nothing
  // was written) but the command as documented did not work, and the fix an
  // operator would reach for under time pressure is to start guessing flags.
  //
  // Depending on ambient environment for "where things are now" is the wrong
  // shape regardless: FLUID_DROPLET_URL is whatever this deployment was
  // configured with, which is exactly the value that stops being true halfway
  // through a migration.
  const fromFlag = flag(args, "--from");
  if (!fromFlag) {
    fail(
      `repoint needs --from <current origin>.\n\n` +
        `  It names where the registrations are NOW, and it is how they are\n` +
        `  found: without it only the destination is searched, so a first\n` +
        `  cutover matches nothing and exits having done nothing.\n\n` +
        `  cut over:  --from <rails-service> --url <next-service>  --webhook-path ${NEXT_WEBHOOK_PATH}\n` +
        `  roll back: --from <next-service>  --url <rails-service> --webhook-path ${RAILS_WEBHOOK_PATH}`,
    );
  }
  const origins = [target, normaliseOrigin(fromFlag, "--from")];

  const webhooks = await listWebhooks(client);
  const ours = webhooks.filter((w) => isOurs(w, origins));

  if (ours.length === 0) {
    fail(
      `Matched no webhooks of ours for ${company.fluidShop}.\n\n` +
        `  Looked for ${WEBHOOK_PATHS.join(" or ")} under:\n` +
        origins.map((o) => `    ${o}`).join("\n") +
        `\n\n  Fluid holds ${webhooks.length} webhook(s) for this company. If ` +
        `one of them is ours at a third origin — an older region hostname, say ` +
        `— pass it with --from. Exiting non-zero rather than reporting a ` +
        `no-op success.`,
    );
  }

  // Every enabled subscription must be accounted for BEFORE anything moves.
  //
  // Install-time registration failures are logged and swallowed
  // (src/lib/handlers/droplet-installed.ts), so a company can be live with
  // `order.created` registered and `order.updated` never created at all.
  const { missing, dead } = completenessProblems(ours);
  if (missing.length > 0 || dead.length > 0) {
    fail(
      `Refusing to repoint ${company.fluidShop}.\n\n` +
        describeCompleteness(missing, dead) +
        `  Nothing has been changed.`,
    );
  }

  const holdsToken = !!company.webhookVerificationToken;
  const blocked = ours.filter((w) => !isBootstrap(w) && !holdsToken);
  if (blocked.length > 0) {
    fail(
      `Refusing to repoint ${company.fluidShop}.\n\n` +
        `  ${blocked.map(describe).join(", ")} verify against this company's ` +
        `own webhook_verification_token, and we hold none. Moving them would ` +
        `make every delivery 401 while Rails stops receiving them — the orders ` +
        `would stop, silently, behind a retry.\n\n` +
        `  Reinstall the droplet for this company to obtain the token, then ` +
        `re-run. Nothing has been changed.`,
    );
  }

  // Destination checks — and ONLY for this app's own path.
  //
  // Rails cannot be probed. It answers 404 to an unauthenticated POST on its
  // real /webhook route, and 404 to a route that does not exist. Measured
  // against production:
  //
  //   POST /webhook       {droplet.uninstalled}  -> 404
  //   POST /webhook       {order.created}        -> 404
  //   POST /api/webhooks  (not a Rails route)    -> 404
  //
  // So no external probe distinguishes a healthy Rails endpoint from a missing
  // one, and it does not speak HMAC either — `authenticate_webhook_token`
  // reads an AUTH_TOKEN header. Running these checks against Rails would fail
  // every one of them and BLOCK ROLLBACK, which is the one operation that must
  // always work. They are skipped, deliberately; do not "fix" this by adding a
  // probe that cannot work.
  if (path === NEXT_WEBHOOK_PATH) {
    // Prove the destination route is actually mounted before pointing anything at
    // it. The read-back after the write only proves fluid stored what we asked
    // for; it cannot tell a live route from a 404. An unsigned POST is enough —
    // the webhook route fails closed, so 401 means mounted and verifying, and
    // 404 means we would be registering a url nothing serves.
    const probe = await fetch(targetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resource: "droplet", event: "installed" }),
    }).catch((error: unknown) => {
      fail(
        `Could not reach ${targetUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    // EXACTLY 401. Not merely "not 404".
    //
    // The webhook route fails closed, so an unsigned request has one correct
    // answer and every other status means something is wrong in a way that
    // repointing would make live:
    //
    //   404  nothing serves the route
    //   200  the route did NOT verify — an unsigned request was accepted, which
    //        is the one outcome worse than the route being missing
    //   403  something in front of the service is refusing us
    //   5xx  the route is mounted and broken
    //
    // Accepting anything but 401 was the earlier version's flaw: it proved a
    // route existed, not that it was doing its job.
    if (probe.status !== 401) {
      fail(
        `${targetUrl} answered ${probe.status} to an unsigned webhook; expected 401.\n\n` +
          (probe.status === 404
            ? `  404 means nothing serves that route — check --url and --webhook-path.`
            : probe.status === 200
              ? `  200 means the route ACCEPTED an unsigned request. Do not point\n` +
                `  production traffic at it: it is not verifying signatures.`
              : `  The route is reachable but not answering as a healthy webhook\n` +
                `  endpoint should. Investigate before repointing anything.`),
      );
    }
    console.log(`Destination ${targetUrl} refused an unsigned webhook with 401.`);

    // Second probe, SIGNED with the very token this run is about to write onto
    // the bootstrap registrations.
    //
    // The unsigned probe proves the route verifies. It says nothing about
    // whether OUR token is the one it accepts — so a stale but non-empty
    // FLUID_WEBHOOK_AUTH_TOKEN passes it, gets written onto
    // droplet.installed/uninstalled, and every lifecycle delivery 401s
    // afterwards. Signing the probe with the same value closes that gap.
    //
    // `droplet.uninstalled` with a made-up installation uuid, NOT
    // droplet.installed. Both are bootstrap events so either proves the point,
    // but the install handler WRITES — it would create a companies row from this
    // payload. The uninstall handler resolves the company first and returns when
    // it finds none, so nothing is touched. This has to stay safe to fire at
    // production.
    const probeBody = JSON.stringify({
      resource: "droplet",
      event: "uninstalled",
      company: { droplet_installation_uuid: "cutover-preflight-not-a-real-installation" },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", authToken)
      .update(`${timestamp}.${probeBody}`)
      .digest("hex");

    const signed = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Fluid-Timestamp": String(timestamp),
        "X-Fluid-Signature": signature,
      },
      body: probeBody,
    }).catch((error: unknown) => {
      fail(
        `Signed preflight to ${targetUrl} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    // 202 (handled) or 204 (no company matched the made-up uuid, so the handler
    // returned early) both mean the SIGNATURE was accepted, which is the only
    // thing being asked. Deliberately NOT "anything but 401": a transport error
    // or a 500 would otherwise read as success.
    if (![200, 202, 204].includes(signed.status)) {
      fail(
        `Signed preflight to ${targetUrl} answered ${signed.status}.\n\n` +
          (signed.status === 401
            ? `  401 means the destination does not accept FLUID_WEBHOOK_AUTH_TOKEN.\n` +
              `  Writing it onto the droplet.installed / droplet.uninstalled\n` +
              `  registrations would make every lifecycle delivery fail. Check the\n` +
              `  token against the destination service's own secret.`
            : `  Expected 202 or 204. The route is reachable and verifying, but did\n` +
              `  not complete this request — investigate before repointing.`),
      );
    }
    console.log(
      `Destination accepted a webhook signed with FLUID_WEBHOOK_AUTH_TOKEN (${signed.status}).`,
    );

    // Third probe: can the destination actually DO the work?
    //
    // The two above prove the route is mounted and verifying. Neither touches
    // the database, and that is exactly the gap that took nuvamed down on
    // 2026-09-08: the service was reachable, refused unsigned requests,
    // accepted signed ones, and then 500'd every real order because its Prisma
    // schema described an `integration_settings` column the database does not
    // have. Order 46253711 was lost and replayed by hand (STU2-3293).
    //
    // /api/health/deep runs the order path's own settings query and decrypts
    // what it finds, reporting counts only. A destination that cannot pass it
    // would not have survived its first order.
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      fail(
        `CRON_SECRET is not set, so the destination's deep health check cannot\n` +
          `  be called. That check is what proves this service can read a\n` +
          `  company's ShipStation credentials at all — reachability and\n` +
          `  signatures do not.\n\n` +
          `  Run through scripts/db-connect.sh --exec, which supplies it.`,
      );
    }

    // SCOPED to the company being moved. An unscoped deep check aggregates over
    // every active company, so it answers 200 whenever ANY tenant's settings
    // decrypt — including when the company we are about to repoint holds no
    // settings row at all, which is precisely the "reachable but cannot do the
    // job" shape that took nuvamed down. Ask about the company we are moving.
    const deepUrl =
      `${target}/api/health/deep?company=${encodeURIComponent(company.fluidShop)}`;
    const deep = await fetch(deepUrl, {
      headers: { authorization: `Bearer ${cronSecret}` },
    }).catch((error: unknown) => {
      fail(
        `Could not reach ${deepUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    const deepBody = (await deep.json().catch(() => null)) as {
      ok?: boolean;
      database?: boolean;
      integrationSettings?: {
        queried?: number;
        decryptable?: number;
        undecryptable?: number;
        unusable?: number;
      };
      scoped?: boolean;
      error?: string | null;
    } | null;

    if (deep.status !== 200 || !deepBody?.ok) {
      const counts = deepBody?.integrationSettings;
      fail(
        `${deepUrl} answered ${deep.status} and did not report healthy.\n\n` +
          `  database reachable:    ${deepBody?.database ?? "unknown"}\n` +
          `  settings rows queried: ${counts?.queried ?? "unknown"}\n` +
          `  decryptable + usable:  ${counts?.decryptable ?? "unknown"}\n` +
          `  UNDECRYPTABLE:         ${counts?.undecryptable ?? "unknown"}\n` +
          `  decrypted but UNUSABLE: ${counts?.unusable ?? "unknown"}\n` +
          (deepBody?.error ? `  error: ${deepBody.error}\n` : "") +
          `\n  The destination is reachable and verifies signatures, but cannot\n` +
          `  do the work. Repointing would 500 every order. Nothing changed.`,
      );
    }
    // An older build of the endpoint has no `scoped` field and answers about
    // every company. Treating that as a pass for THIS company would restore the
    // exact gap this probe was added to close, so refuse it.
    if (deepBody.scoped !== true) {
      fail(
        `${deepUrl} did not report a company-scoped answer.\n\n` +
          `  The destination is running a build of /api/health/deep that predates\n` +
          `  ?company= scoping, so a 200 there means "some company's settings\n` +
          `  decrypt", not "${company.fluidShop}'s do". Deploy the current build\n` +
          `  before repointing. Nothing has been changed.`,
      );
    }
    console.log(
      `Destination can read ${company.fluidShop}'s ShipStation credentials ` +
        `and they are usable for its configured api_version.`,
    );
  } else {
    // Rails: the WEBHOOK route cannot be probed, but the SERVICE can.
    //
    // Skipping every check meant a mistyped but syntactically valid host —
    // `fluid-droplet-shipstatoin`, say — was accepted, every registration
    // updated, the read-back confirmed, and the run reported success while
    // deliveries reached nothing at all. The webhook route stays unprobeable;
    // the host does not have to be.
    //
    // `/up` is Rails's own health endpoint (config/routes.rb:
    // `get "up" => "rails/health#show"`). It also discriminates: measured
    // against production it returns 200 on the Rails service and 404 on the
    // Next one, so it catches a --url pointed at the wrong app as well as at
    // no app.
    const healthUrl = `${target}/up`;
    const health = await fetch(healthUrl, { method: "GET" }).catch(
      (error: unknown) => {
        fail(
          `Could not reach ${healthUrl}: ${
            error instanceof Error ? error.message : String(error)
          }\n\n  Check --url. Nothing has been changed.`,
        );
      },
    );
    if (health.status !== 200) {
      fail(
        `${healthUrl} answered ${health.status}; expected 200.\n\n` +
          `  That is Rails's own health endpoint, so this is either the wrong\n` +
          `  host or a service that is not up. The Next service answers 404\n` +
          `  there, so check --url is really the Rails one.\n\n` +
          `  Nothing has been changed.`,
      );
    }
    console.log(
      `Destination ${target} is up (GET /up -> 200). The webhook route itself\n` +
        `cannot be probed on Rails — it answers 404 to any unauthenticated\n` +
        `request, healthy or not — so the signature checks stay disabled here.`,
    );
  }

  console.log(`Company ${company.fluidShop} (id ${company.id})`);
  console.log(`Repointing ${ours.length} webhook(s) to ${targetUrl}\n`);

  // Every id this run is responsible for, whether it was updated now or was
  // already there. Both must end up at targetUrl for the run to be a success.
  const movedIds: string[] = [];

  for (const webhook of ours) {
    movedIds.push(String(webhook.id));
    const already = webhook.url === targetUrl;
    const label = `  ${describe(webhook).padEnd(22)} ${webhook.url} ->`;

    // A webhook already at the destination is still WRITTEN under APPLY.
    //
    // It used to be skipped as complete. But the url is not the only thing
    // this update sets — it also sets auth_token, and fluid never returns the
    // stored one, so there is no way to look at a registration and tell which
    // token it carries. A registration moved by hand, or left behind by a
    // partial run, can sit at exactly the right url with the WRONG token:
    // fluid signs with that stale value, this app verifies against
    // webhookVerificationToken, and every delivery 401s while the tool reports
    // the company complete.
    //
    // The update is idempotent, so rewriting costs one API call and removes a
    // state nothing else can detect. Dry run still prints the distinction,
    // because an operator reading the plan should see which rows are moving
    // and which are only being re-tokened.
    if (already && !APPLY) {
      console.log(`${label} (already there; token would be rewritten)`);
      continue;
    }
    if (!APPLY) {
      console.log(`${label} ${targetUrl}   [dry run]`);
      continue;
    }
    if (!webhook.resource || !webhook.event) {
      // The update schema requires both. A listing row missing them cannot be
      // updated without inventing values, and inventing them would re-subscribe
      // the webhook to a different event.
      fail(
        `Webhook ${webhook.id} came back without a resource or event, so it ` +
          `cannot be updated without guessing what it subscribes to. ` +
          `Stopped after ${ours.indexOf(webhook)} change(s).`,
      );
    }

    // The token this webhook must be signed with, per webhook — NOT one shared
    // value for all of them.
    //
    // fluid's `Webhook#auth_token` is
    // `droplet_installation&.webhook_verification_token || super`, so the
    // stored column is only consulted when the webhook is NOT linked to an
    // installation. Sending the shared secret for everything was therefore
    // correct only for linked webhooks, and silently wrong for an unlinked
    // `order.*`: fluid would sign it with the shared token and
    // src/app/api/webhooks/route.ts accepts that token for lifecycle events
    // ONLY, so every delivery would 401.
    //
    // Sending the company's own verification token for non-bootstrap webhooks
    // is right in both branches — ignored when an installation link exists,
    // and exactly what the route expects when it does not.
    const webhookToken = isBootstrap(webhook)
      ? sharedToken
      : (company.webhookVerificationToken ?? sharedToken);

    await client.updateWebhook(String(webhook.id), {
      resource: webhook.resource,
      event: webhook.event,
      url: targetUrl,
      auth_token: webhookToken,
      http_method: "post",
      active: webhook.active ?? true,
    });
    console.log(
      `${label} ${targetUrl}   ${already ? "token rewritten" : "updated"}`,
    );
  }

  if (!APPLY) {
    console.log(`\nDry run. Re-run with APPLY=1 to write.`);
    return;
  }

  // Read back rather than trust the writes. An update that 200s and does not
  // move the url is the failure this exists to catch.
  //
  // Verified by the IDS WE JUST TOUCHED, not by re-running `isOurs` over the
  // new listing. `isOurs` only recognises the two known paths, so a typo'd
  // --webhook-path (`/api/webhook`, say) moved every registration to a route
  // nothing serves and then made them invisible to this check — the straggler
  // list came back empty and it printed "Verified: every webhook of ours is
  // now at ...". A verification that stops seeing what it just broke is worse
  // than no verification, because it is believed.
  const after = await listWebhooks(client);
  const byId = new Map(after.map((w) => [String(w.id), w]));
  const stragglers = movedIds
    .map((id) => byId.get(id) ?? { id, url: "(no longer listed)" })
    .filter((w) => w.url !== targetUrl);

  if (stragglers.length > 0) {
    fail(
      `\n${stragglers.length} of the ${movedIds.length} webhook(s) updated are ` +
        `not at ${targetUrl}:\n` +
        stragglers
          .map((w) => `    id ${w.id}  ${w.url}`)
          .join("\n"),
    );
  }
  console.log(
    `\nVerified: all ${movedIds.length} webhook(s) updated are at ${targetUrl}.`,
  );
}

async function main() {
  const [command, handle, ...args] = process.argv.slice(2);

  if (!command || !handle) {
    console.error(
      `usage:\n` +
        `  pnpm cutover status <fluid_shop> --from <current> --url <destination>\n` +
        `  APPLY=1 pnpm cutover repoint <fluid_shop> --from <current> --url <destination> --webhook-path <path>`,
    );
    process.exit(2);
  }

  switch (command) {
    case "status":
      await status(handle, args);
      break;
    case "repoint":
      await repoint(handle, args);
      break;
    default:
      fail(`Unknown command "${command}". Expected status or repoint.`);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * Moves ONE company's Fluid webhook registrations between the Rails app and the
 * Next app, and reports whether doing so would keep that company's orders
 * flowing.
 *
 *   pnpm cutover status  <fluid_shop>
 *   APPLY=1 pnpm cutover repoint <fluid_shop> \
 *     --url https://fluid-droplet-shipstation-next-....run.app \
 *     --webhook-path /api/webhooks
 *
 * Rollback is the same command aimed back at Rails — and it MUST carry Rails's
 * own path, because the two apps do not agree on it:
 *
 *   APPLY=1 pnpm cutover repoint <fluid_shop> \
 *     --url https://fluid-droplet-shipstation-....run.app \
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

import { prisma } from "@/lib/db";
import { createFluidClient, type FluidClient } from "@/lib/fluid";
import { dropletConfig } from "@/lib/config";

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
 * An operator-supplied `--url`, reduced to something safe to concatenate a path
 * onto. Only http(s), and no query or fragment: `${base}${path}` on
 * `https://host/?x` produces `https://host/?x/api/webhooks`, which registers a
 * url nothing serves.
 */
function normaliseOrigin(value: string, flag: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return fail(`${flag} must be an absolute https url; got "${value}".`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    fail(`${flag} must be http(s); got "${value}".`);
  }
  if (parsed.search || parsed.hash) {
    fail(`${flag} must not carry a query or fragment; got "${value}".`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "");
}

/**
 * A `--webhook-path`, checked before it is concatenated. A value not beginning
 * with a single "/" is not a path: `${origin}@evil.example/x` has host
 * evil.example, so the flag would be choosing the destination host.
 */
function normalisePath(value: string, flag: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    fail(
      `${flag} must be an absolute path beginning with a single "/"; got "${value}".`,
    );
  }
  return value;
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
 * NOT a bare `listWebhooks()`. That endpoint defaults to 30 per page
 * (`Api::Company::Webhooks::IndexAction`), and the listing is COMPANY-scoped:
 * an active company carries a webhook for every droplet it has installed.
 * nuvamed has well over thirty. A single unpaged call returned the first page
 * only, which on the internal `fluid.fluid.app` install silently omitted an
 * `order.created` of ours — a repoint would have moved two webhooks of three,
 * verified the two it knew about, and reported success.
 *
 * The page cap fails loudly rather than returning a truncated list, because a
 * partial answer here is indistinguishable from a complete one at every call
 * site above.
 */
const PER_PAGE = 100;
const MAX_PAGES = 50;

async function listWebhooks(client: FluidClient): Promise<FluidWebhook[]> {
  const all: FluidWebhook[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await client.listWebhooks({ page, per_page: PER_PAGE });
    const batch = (response?.webhooks ?? []) as FluidWebhook[];
    all.push(...batch);
    if (batch.length < PER_PAGE) return all;
  }
  fail(
    `Fluid returned ${MAX_PAGES} full pages of webhooks (${MAX_PAGES * PER_PAGE}+) ` +
      `for this company. Refusing to act on a list that may be truncated.`,
  );
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

  const destination = flag(args, "--url");
  const origins = [
    destination ? normaliseOrigin(destination, "--url") : null,
    process.env.FLUID_DROPLET_URL
      ? normaliseOrigin(process.env.FLUID_DROPLET_URL, "FLUID_DROPLET_URL")
      : null,
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
      `\nNeither --url nor FLUID_DROPLET_URL was set, so nothing could be ` +
        `matched as ours. Re-run with --url <destination> to see what repoint ` +
        `would move.`,
    );
    return;
  }

  const ours = webhooks.filter((w) => isOurs(w, origins));
  const blocked = ours.filter((w) => !isBootstrap(w) && !holdsToken);

  console.log(`\n${ours.length} webhook(s) would be repointed.`);

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
  const from = flag(args, "--from");
  const origins = [
    target,
    from ? normaliseOrigin(from, "--from") : null,
    process.env.FLUID_DROPLET_URL
      ? normaliseOrigin(process.env.FLUID_DROPLET_URL, "FLUID_DROPLET_URL")
      : null,
  ].filter((value): value is string => value !== null);

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

  console.log(`Company ${company.fluidShop} (id ${company.id})`);
  console.log(`Repointing ${ours.length} webhook(s) to ${targetUrl}\n`);

  for (const webhook of ours) {
    const already = webhook.url === targetUrl;
    const label = `  ${describe(webhook).padEnd(22)} ${webhook.url} ->`;

    if (already) {
      console.log(`${label} (already there)`);
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
    console.log(`${label} ${targetUrl}   updated`);
  }

  if (!APPLY) {
    console.log(`\nDry run. Re-run with APPLY=1 to write.`);
    return;
  }

  // Read back rather than trust the writes. An update that 200s and does not
  // move the url is the failure this exists to catch.
  const after = await listWebhooks(client);
  const stragglers = after
    .filter((w) => isOurs(w, origins))
    .filter((w) => w.url !== targetUrl);

  if (stragglers.length > 0) {
    fail(
      `\n${stragglers.length} webhook(s) are still not at ${targetUrl} after ` +
        `the update:\n` +
        stragglers.map((w) => `    ${describe(w)}  ${w.url}`).join("\n"),
    );
  }
  console.log(`\nVerified: every webhook of ours is now at ${targetUrl}.`);
}

async function main() {
  const [command, handle, ...args] = process.argv.slice(2);

  if (!command || !handle) {
    console.error(
      `usage:\n` +
        `  pnpm cutover status  <fluid_shop> [--url <base>]\n` +
        `  APPLY=1 pnpm cutover repoint <fluid_shop> --url <base> --webhook-path <path> [--from <base>]`,
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

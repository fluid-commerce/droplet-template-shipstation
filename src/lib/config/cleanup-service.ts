/**
 * Cleanup Service
 *
 * Removes the per-company webhooks registered on install. Fluid removes
 * webhooks itself when a droplet is uninstalled, so this is belt-and-braces.
 *
 * Callback registrations are cleaned up by
 * src/lib/callbacks/registration.ts#cleanupCallbacksForCompany, which deletes
 * by the uuids this droplet recorded at install rather than by scanning the
 * company-scoped listing — that listing also contains other droplets'
 * registrations, and matching them by definition name would delete theirs.
 */

import type { FluidClient } from "@/lib/fluid";
import type { DropletConfig } from "./schema";
import { filterEnabled } from "./schema";
import { webhookUrl } from "./registration-service";

export type CleanupResults = {
  webhooks: { success: number; failed: number };
};

async function cleanupWebhooks(
  client: FluidClient,
  config: DropletConfig,
): Promise<CleanupResults["webhooks"]> {
  const results = { success: 0, failed: 0 };
  const enabled = filterEnabled(config.webhooks);
  if (enabled.length === 0) return results;

  // Paged, not a bare listWebhooks(). That returns 30, and the listing is
  // company-scoped: a company carrying several droplets goes past that easily.
  // Reading one page here meant uninstall could fail to find our own webhooks
  // and leave them registered against a droplet that is gone, with fluid still
  // delivering to it.
  let webhooks: Awaited<ReturnType<FluidClient["listAllWebhooks"]>>;
  try {
    webhooks = await client.listAllWebhooks();
  } catch (error) {
    console.error(
      "[Cleanup] Failed to list webhooks:",
      error instanceof Error ? error.message : error,
    );
    return results;
  }

  const ourUrl = webhookUrl();

  for (const wanted of enabled) {
    const matching = webhooks.filter(
      (w) =>
        w.resource === wanted.resource &&
        w.event === wanted.event &&
        // Resource+event alone is NOT ownership. Fluid's listing is scoped to
        // the COMPANY, not to this droplet, so `order.created` in it may be
        // another installed droplet's subscription — deleting that on our
        // uninstall would silently stop their orders. The callback cleanup
        // already avoids exactly this mistake by deleting recorded uuids; the
        // closest webhook equivalent is an exact URL match. Rails deleted no
        // webhooks at all on uninstall, so refusing to delete an unmatched one
        // is also the more faithful behaviour.
        sameUrl(w.url, ourUrl),
    );
    for (const webhook of matching) {
      try {
        await client.deleteWebhook(String(webhook.id));
        results.success++;
      } catch (error) {
        results.failed++;
        console.error(
          `[Cleanup] ❌ Failed to delete webhook ${webhook.id}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  return results;
}

/** Compares two webhook URLs, ignoring a trailing slash. */
function sameUrl(candidate: string | undefined, ours: string | null): boolean {
  if (!ours || !candidate) return false;
  return candidate.replace(/\/$/, "") === ours;
}

export async function cleanupAllFeatures(
  client: FluidClient,
  config: DropletConfig,
): Promise<CleanupResults> {
  return { webhooks: await cleanupWebhooks(client, config) };
}

/**
 * Webhook endpoint.
 *
 * Port of app/controllers/webhooks_controller.rb, wrapped in the SDK's
 * `withFluidWebhook`.
 *
 * Webhooks are not the checkout path, so this route refuses loudly: an
 * unverified request gets a 401 and nothing runs. That is the opposite of the
 * callback routes, and it is deliberate — a rejected webhook is a retry, while
 * a rejected callback is a broken cart.
 *
 * What the wrapper replaces, and why it is an improvement on the Ruby:
 *
 *  - The Rails controller authenticated `droplet.installed` / `droplet.uninstalled`
 *    by comparing `params[:company][:droplet_uuid]` against the configured
 *    droplet uuid. That is a value the caller supplies, so anyone who knew the
 *    droplet's uuid — which Fluid publishes in the marketplace — could forge an
 *    install and hand this droplet a `companies` row with credentials of their
 *    choosing. Here the same events are verified by HMAC against the shared
 *    bootstrap secret, and the uuid check remains as a routing guard inside the
 *    handler rather than as the authentication.
 *  - Every other event was authenticated by a plaintext `AUTH_TOKEN` header
 *    compared with `include?` — not timing-safe, and satisfied by the SHARED
 *    webhook token, so any installed company's token authenticated a webhook
 *    about any other company. Here a non-bootstrap event must verify against
 *    that company's own `webhook_verification_token`.
 */

import { withFluidWebhook, INSTALL_EVENT } from "@fluid-studios/droplet-sdk/next";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { routeEvent, hasHandler } from "@/lib/events";
import { unwrapLifecycleEnvelope } from "@/lib/events/lifecycle-envelope";
import { initializeHandlers } from "@/lib/handlers";

initializeHandlers();

/**
 * Events allowed to authenticate with the shared bootstrap secret.
 *
 * `droplet.installed` has to be here: it is the event that delivers the
 * company's own token, so no per-company secret exists yet.
 *
 * `droplet.uninstalled` is here too, because Fluid signs it with the same
 * droplet-level webhook this app registers (WebhookManager creates both with
 * `auth_token: fluid_webhook.auth_token`), not with the company's token.
 */
const BOOTSTRAP_EVENTS = [INSTALL_EVENT, "droplet.uninstalled"];

/**
 * The secret Fluid signs `droplet.installed` / `droplet.uninstalled` with.
 *
 * When the droplet record has an `install_webhook_url` (this one does), Fluid
 * delivers lifecycle events through `Droplet::WebhookDispatcher`, which HMACs
 * the body with the DROPLET'S OWN `webhook_secret`
 * (`webhook_notifier.rb#lifecycle_webhook_data`, `webhook_dispatcher.rb#request_headers`)
 * — not with the shared token this app writes onto per-company webhooks. The
 * Rails app never noticed: it authenticated installs by comparing a body
 * field, not a signature.
 *
 * Falls back to FLUID_WEBHOOK_AUTH_TOKEN so a deployment without the new
 * variable keeps its current behaviour.
 */
const LIFECYCLE_SECRET =
  process.env.FLUID_DROPLET_WEBHOOK_SECRET || process.env.FLUID_WEBHOOK_AUTH_TOKEN;


export const POST = withFluidWebhook(
  {
    name: "droplet",
    bootstrapSecret: LIFECYCLE_SECRET,
    bootstrapEvents: BOOTSTRAP_EVENTS,

    /**
     * Finds the candidate secret for a webhook, from untrusted routing hints.
     *
     * Unlike a callback, a webhook's secret is per-company, so the tenant has
     * to be guessed before verification and only trusted afterwards. Returning
     * null means no candidate — which for a bootstrap event is fine, the shared
     * secret is tried next, and for anything else is an auth failure.
     */
    async resolve({ dri, fluidShop, companyId }) {
      const company = dri
        ? await prisma.company.findFirst({
            where: { dropletInstallationUuid: dri },
          })
        : companyId !== undefined
          ? await prisma.company.findFirst({
              where: { fluidCompanyId: BigInt(companyId) },
            })
          : fluidShop
            ? await prisma.company.findFirst({ where: { fluidShop } })
            : null;

      if (!company?.webhookVerificationToken) return null;

      return {
        secret: company.webhookVerificationToken,
        principal: company,
      };
    },
  },

  async ({ event, payload, principal }) => {
    console.log(`[Webhook] Received: ${event}`);

    // Rails answered 204 when nothing was registered for the event, and 202
    // when a job was enqueued. Both are kept; the difference is that the work
    // has actually finished by the time 202 is returned. See the note in
    // src/lib/events/event-handler.ts on why this runs inline.
    if (!hasHandler(event)) {
      return new NextResponse(null, { status: 204 });
    }

    try {
      // `principal` is the tenant the signature actually verified against.
      // Handlers must resolve the company from it, never from a body field:
      // the body is attacker-controlled, and a payload naming a DIFFERENT
      // company than the one whose secret signed it would otherwise be
      // processed with that other tenant's ShipStation and Fluid credentials.
      const handled = await routeEvent(
        event,
        unwrapLifecycleEnvelope(payload),
        undefined,
        principal,
      );
      return new NextResponse(null, { status: handled ? 202 : 204 });
    } catch (error) {
      // The payload is never logged here: it carries authentication_token and
      // webhook_verification_token on an install.
      console.error(
        `[Webhook] Handler failed for ${event}:`,
        error instanceof Error ? error.message : error,
      );
      // A 5xx is a retry signal to Fluid, which is what a transient database or
      // Fluid API failure deserves.
      return NextResponse.json(
        { error: "internal error" },
        { status: 500 },
      );
    }
  },
);

export function GET() {
  return NextResponse.json({ status: "ok", service: "droplet-template-webhooks" });
}

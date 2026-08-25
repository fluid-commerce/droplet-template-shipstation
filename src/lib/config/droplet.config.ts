/**
 * Droplet Configuration
 *
 * Per-company webhooks registered when a company installs this droplet. These
 * are separate from the droplet-level `droplet.installed` /
 * `droplet.uninstalled` webhooks, which are created once by the admin
 * dashboard's "Create Droplet" action — see src/lib/use-cases/droplet.ts.
 *
 * Port of DropletInstalledJob#create_order_webhooks: the Rails app registered
 * exactly these two, so exactly these two are enabled here.
 *
 * Callbacks live in the `callbacks` table, not here. See ./schema.ts — and note
 * that this droplet registers none: it has no callback route, and every synced
 * `callbacks` row is created inactive.
 */

import type { DropletConfig } from "./schema";

export const dropletConfig: DropletConfig = {
  webhooks: [
    {
      enabled: true,
      resource: "order",
      event: "created",
      description: "A new Fluid order to push into ShipStation",
    },
    {
      // Releases orders held as AWAITING_PAYMENT once they become fulfillable,
      // reconciles genuine edits, and carries cancellations.
      enabled: true,
      resource: "order",
      event: "updated",
      description: "An existing order changed — status, address, or items",
    },
  ],
};

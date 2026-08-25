/**
 * Droplet configuration schema.
 *
 * Declares the per-company webhooks this droplet registers on install.
 *
 * Two things that belong in a droplet config are deliberately NOT here:
 *
 *  - **Callbacks.** The Rails app this replaces kept its callback catalogue in
 *    the `callbacks` table — synced from Fluid's definition list and edited in
 *    the admin UI — and registration reads from that table so an operator can
 *    turn a callback on without a deploy. Duplicating the list in code would
 *    create two sources of truth that disagree the moment someone uses the UI.
 *    See src/lib/callbacks.
 *  - **Dropzones.** The Rails template never registered any, so nothing was
 *    ported. Fluid's `/api/drop_zones` endpoints are real and a droplet forked
 *    from this template can add them; they are just not invented here.
 */

import { z } from "zod";

export const webhookConfigSchema = z.object({
  enabled: z.boolean().default(true),
  resource: z.string().describe("Resource type (e.g. 'order', 'cart')"),
  event: z.string().describe("Event name (e.g. 'created', 'updated')"),
  description: z.string().optional(),
});

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

export const dropletConfigSchema = z.object({
  webhooks: z.array(webhookConfigSchema).default([]),
});

export type DropletConfig = z.infer<typeof dropletConfigSchema>;

export function validateConfig(config: unknown): DropletConfig {
  return dropletConfigSchema.parse(config);
}

export function filterEnabled<T extends { enabled: boolean }>(items: T[]): T[] {
  return items.filter((item) => item.enabled);
}

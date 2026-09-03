/**
 * Webhook cleanup on uninstall.
 *
 * Fluid's webhook listing is scoped to the COMPANY, not to this droplet, so it
 * also contains subscriptions other installed droplets own. Deleting by
 * resource+event alone would take theirs down with ours.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { cleanupAllFeatures } from "./cleanup-service";
import type { DropletConfig } from "./schema";

const config: DropletConfig = {
  webhooks: [
    { enabled: true, resource: "order", event: "created", description: "" },
  ],
};

const listWebhooks = vi.fn();
const deleteWebhook = vi.fn(async () => {});

const client = () =>
  ({ listWebhooks, deleteWebhook }) as unknown as Parameters<
    typeof cleanupAllFeatures
  >[0];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.FLUID_DROPLET_URL = "https://ours.example.com";
});

describe("cleanupAllFeatures", () => {
  it("deletes this droplet's own order.created subscription", async () => {
    listWebhooks.mockResolvedValue({
      webhooks: [
        {
          id: 1,
          resource: "order",
          event: "created",
          url: "https://ours.example.com/api/webhooks",
        },
      ],
    });

    const results = await cleanupAllFeatures(client(), config);

    expect(deleteWebhook).toHaveBeenCalledWith("1");
    expect(results.webhooks.success).toBe(1);
  });

  it("leaves another droplet's order.created subscription alone", async () => {
    listWebhooks.mockResolvedValue({
      webhooks: [
        {
          id: 2,
          resource: "order",
          event: "created",
          url: "https://someone-else.example.com/api/webhooks",
        },
      ],
    });

    await cleanupAllFeatures(client(), config);

    expect(deleteWebhook).not.toHaveBeenCalled();
  });

  it("ignores a trailing slash on the configured droplet url", async () => {
    process.env.FLUID_DROPLET_URL = "https://ours.example.com/";
    listWebhooks.mockResolvedValue({
      webhooks: [
        {
          id: 3,
          resource: "order",
          event: "created",
          url: "https://ours.example.com/api/webhooks",
        },
      ],
    });

    await cleanupAllFeatures(client(), config);

    expect(deleteWebhook).toHaveBeenCalledWith("3");
  });
});

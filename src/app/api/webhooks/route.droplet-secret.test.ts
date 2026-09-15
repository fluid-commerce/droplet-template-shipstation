/**
 * Webhook route with FLUID_DROPLET_WEBHOOK_SECRET set.
 *
 * Fluid signs lifecycle events with the droplet record's own webhook_secret;
 * once that is configured, the shared token must no longer authenticate them.
 *
 * The opposite policy to a callback: this is not the checkout path, so an
 * unverified request is refused loudly with a 401 and nothing runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.hoisted(() => {
  process.env.FLUID_DROPLET_WEBHOOK_SECRET = "dws_droplet_secret";
});

import { companyFixture } from "@/test/factories";
import { signedWebhookRequest } from "@/test/signing";

const mockPrisma = vi.hoisted(() => ({
  company: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  callback: { findMany: vi.fn() },
  fluidCallbackRegistration: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(),
  },
}));

const handleInstalled = vi.hoisted(() => vi.fn(async () => {}));
const handleUninstalled = vi.hoisted(() => vi.fn(async () => {}));
const handleOrderCreated = vi.hoisted(() => vi.fn(async () => {}));
const handleOrderUpdated = vi.hoisted(() => vi.fn(async () => {}));
const handleOrderShipped = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/handlers/droplet-installed", () => ({
  handleDropletInstalled: handleInstalled,
}));
vi.mock("@/lib/handlers/droplet-uninstalled", () => ({
  handleDropletUninstalled: handleUninstalled,
}));
vi.mock("@/lib/handlers/order-events", () => ({
  handleOrderCreated,
  handleOrderUpdated,
  handleOrderShipped,
}));

const { POST } = await import("./route");

const installBody = {
  resource: "droplet",
  event: "installed",
  company: {
    fluid_shop: "acme.fluid.app",
    name: "Acme",
    fluid_company_id: 42,
    droplet_uuid: "drp_test",
    droplet_installation_uuid: "dri_acme",
    authentication_token: "cat_acme",
    webhook_verification_token: "wvt_acme",
  },
};

const DROPLET_SECRET = "dws_droplet_secret";
const SHARED = "test-webhook-token";

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.company.findFirst.mockResolvedValue(null);
});

describe("POST /api/webhooks — droplet webhook secret configured", () => {
  it("accepts an enveloped droplet.installed signed with the droplet's webhook_secret", async () => {
    const response = await POST(
      signedWebhookRequest({
        secret: DROPLET_SECRET,
        body: { id: 1, name: "droplet_installed", payload: installBody },
      }),
    );

    expect(response.status).toBe(202);
    expect((handleInstalled.mock.calls as unknown[][])[0]![0]).toEqual(installBody);
  });

  it("refuses droplet.installed signed with the shared token once the droplet secret is set", async () => {
    const response = await POST(signedWebhookRequest({ secret: SHARED, body: installBody }));

    expect(response.status).toBe(401);
    expect(handleInstalled).not.toHaveBeenCalled();
  });

  it("still verifies company events with the company's own token", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyFixture());

    const response = await POST(
      signedWebhookRequest({
        secret: "wvt_acme",
        body: { resource: "order", event: "created", company: { droplet_installation_uuid: "dri_acme" } },
      }),
    );

    expect(response.status).toBe(202);
    expect(handleOrderCreated).toHaveBeenCalledOnce();
  });

  it("does not let the droplet secret authenticate a non-lifecycle event", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(companyFixture());

    const response = await POST(
      signedWebhookRequest({
        secret: DROPLET_SECRET,
        body: { resource: "order", event: "created", company: { droplet_installation_uuid: "dri_acme" } },
      }),
    );

    expect(response.status).toBe(401);
  });
});

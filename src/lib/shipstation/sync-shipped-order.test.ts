/**
 * Syncing a ShipStation shipment back to Fluid.
 *
 * `resource_url` decides where the company's ShipStation credentials get sent,
 * so the host allowlist is checked here as well as at the route — the route is
 * not the only caller.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  company: { findUnique: vi.fn() },
  shipstationOrder: { findFirst: vi.fn(), update: vi.fn() },
}));
const retrieveOrder = vi.hoisted(() => vi.fn());
const createFulfillment = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/fluid-api", () => ({
  retrieveOrder,
  createOrderFulfillment: createFulfillment,
}));
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, credentialsFor: async () => ({ apiKey: "k", apiSecret: "s" }) };
});

const { syncShippedOrder } = await import("./sync-shipped-order");

const GOOD_URL = "https://ssapi.shipstation.com/shipments?batchId=b1";

const shipmentResponse = () =>
  new Response(
    JSON.stringify({
      shipments: [
        {
          orderKey: "555",
          orderNumber: "SO-1",
          trackingNumber: "1Z999",
          carrierCode: "ups",
        },
      ],
    }),
    { status: 200 },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.company.findUnique.mockResolvedValue({
    id: 1n,
    authenticationToken: "cat_acme",
  });
  mockPrisma.shipstationOrder.findFirst.mockResolvedValue({
    id: 10n,
    trackingNumbers: [],
    trackingSyncedToFluid: false,
  });
  mockPrisma.shipstationOrder.update.mockResolvedValue({});
  retrieveOrder.mockResolvedValue({ order: { id: 555, items: [{ id: 1, quantity: 1 }] } });
  vi.stubGlobal("fetch", vi.fn(async () => shipmentResponse()));
});

describe("syncShippedOrder", () => {
  it("records the tracking and fulfils the Fluid order", async () => {
    await syncShippedOrder(GOOD_URL, 1n);

    expect(mockPrisma.shipstationOrder.update.mock.calls[0][0].data).toMatchObject({
      status: "SHIPPED",
      trackingNumbers: ["1Z999"],
      carrier: "ups",
    });
    expect(createFulfillment).toHaveBeenCalledOnce();
  });

  it("refuses a resource_url that is not a ShipStation host", async () => {
    await expect(
      syncShippedOrder("https://attacker.example/shipments?batchId=b1", 1n),
    ).rejects.toThrow(/official ShipStation API endpoint/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not fulfil twice for the same order", async () => {
    mockPrisma.shipstationOrder.findFirst.mockResolvedValue({
      id: 10n,
      trackingNumbers: ["1Z999"],
      trackingSyncedToFluid: true,
    });

    await syncShippedOrder(GOOD_URL, 1n);

    expect(createFulfillment).not.toHaveBeenCalled();
  });

  it("does not duplicate a tracking number it already holds", async () => {
    mockPrisma.shipstationOrder.findFirst.mockResolvedValue({
      id: 10n,
      trackingNumbers: ["1Z999"],
      trackingSyncedToFluid: false,
    });

    await syncShippedOrder(GOOD_URL, 1n);

    expect(
      mockPrisma.shipstationOrder.update.mock.calls[0][0].data.trackingNumbers,
    ).toEqual(["1Z999"]);
  });

  it("throws when ShipStation knows nothing about the batch", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ shipments: [] }), { status: 200 }),
    );

    await expect(syncShippedOrder(GOOD_URL, 1n)).rejects.toThrow(/No shipment found/);
  });
});

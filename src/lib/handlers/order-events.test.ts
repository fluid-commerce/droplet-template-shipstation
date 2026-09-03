/**
 * Order webhook handlers — tenancy and envelope handling.
 *
 * These two things are what stand between a signed webhook and someone else's
 * ShipStation account, so they are tested against the real handlers rather than
 * against mocks of them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  company: { findFirst: vi.fn() },
}));

const createShipstationOrder = vi.hoisted(() => vi.fn(async () => ({})));
const syncShippedOrder = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/shipstation/create-order", () => ({ createShipstationOrder }));
vi.mock("@/lib/shipstation/sync-shipped-order", () => ({ syncShippedOrder }));

const { handleOrderCreated, handleOrderShipped, handleOrderUpdated } =
  await import("./order-events");

/** The tenant whose webhook_verification_token actually signed the request. */
const VERIFIED = { id: 1n, fluidCompanyId: 42n };

const ORDER = { id: 555, order_number: "SO-1", status: "awaiting_shipment" };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.company.findFirst.mockResolvedValue(null);
});

describe("tenancy", () => {
  it("uses the verified company, not the one the body names", async () => {
    await handleOrderCreated(
      { order: ORDER, company: { fluid_company_id: 42 } },
      VERIFIED,
    );

    expect(createShipstationOrder).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: "42" }),
    );
  });

  it("refuses a body that names a company other than the verified one", async () => {
    // The cross-tenant shape: signed with company 42's own secret, but asking
    // this droplet to act on company 200's order — which would be pushed with
    // company 200's ShipStation credentials.
    await expect(
      handleOrderCreated({ order: ORDER, company_id: 200 }, VERIFIED),
    ).rejects.toThrow(/names company 200 but verified against 42/);

    expect(createShipstationOrder).not.toHaveBeenCalled();
  });

  it("refuses the same substitution on order.updated", async () => {
    await expect(
      handleOrderUpdated({ order: ORDER, company_id: 200 }, VERIFIED),
    ).rejects.toThrow(/verified against 42/);

    expect(createShipstationOrder).not.toHaveBeenCalled();
  });

  it("fetches a shipped resource_url with the verified company's credentials", async () => {
    await handleOrderShipped(
      {
        resource_url: "https://ssapi.shipstation.com/shipments?batchId=1",
        company: { droplet_installation_uuid: "dri_other" },
      },
      VERIFIED,
    );

    // Not a lookup on anything the body supplied.
    expect(mockPrisma.company.findFirst).not.toHaveBeenCalled();
    expect(syncShippedOrder).toHaveBeenCalledWith(
      "https://ssapi.shipstation.com/shipments?batchId=1",
      1n,
    );
  });
});

describe("the payload envelope", () => {
  it("reads an order out of a { name, payload } envelope with no `resource`", async () => {
    // `eventOf` routes this shape on `name`, so the handler must be able to
    // read it. Unwrapping only on an inner `resource` key left the order
    // unfound and the delivery acknowledged as handled.
    await handleOrderCreated(
      { name: "order_created", payload: { order: ORDER, company_id: 42 } },
      VERIFIED,
    );

    expect(createShipstationOrder).toHaveBeenCalledWith(
      expect.objectContaining({ order: ORDER }),
    );
  });

  it("still reads the nested shape that does carry `resource`", async () => {
    await handleOrderCreated(
      {
        name: "order_created",
        payload: { resource: "order", event: "created", order: ORDER },
      },
      VERIFIED,
    );

    expect(createShipstationOrder).toHaveBeenCalledWith(
      expect.objectContaining({ order: ORDER }),
    );
  });

  it("throws on a payload with no order, rather than acknowledging it", async () => {
    // A 202 here tells Fluid the order was handled and it is never redelivered.
    await expect(handleOrderCreated({ name: "order_created" }, VERIFIED)).rejects.toThrow(
      /no order/,
    );
  });

  it("throws when a shipped event carries no resource_url", async () => {
    await expect(handleOrderShipped({ company_id: 42 }, VERIFIED)).rejects.toThrow(
      /no resource_url/,
    );
  });
});

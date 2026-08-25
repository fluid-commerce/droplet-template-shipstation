/**
 * createShipstationOrder — the decision table.
 *
 * The case that matters most, and the reason several of these tests exist at
 * all: **this droplet must never modify an order that already has a label.**
 * ShipStation moves a labeled order to "shipped", so both paths that could
 * touch a live ShipStation order ask about that status first and back off.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  company: { findFirst: vi.fn() },
  integrationSetting: { findUnique: vi.fn() },
  shipstationOrder: {
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  shippingMethodMapping: { findFirst: vi.fn() },
  seenShippingMethod: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));

const isShipped = vi.hoisted(() => vi.fn(async () => false));
const cancelOrder = vi.hoisted(() =>
  vi.fn<() => Promise<"cancelled" | "skipped_has_label" | "already_cancelled" | "not_found">>(
    async () => "cancelled",
  ),
);
const updateExternalId = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("./order-status", () => ({ isShipstationOrderShipped: isShipped }));
vi.mock("./cancel-order", () => ({ cancelShipstationOrder: cancelOrder }));
vi.mock("@/lib/fluid-api", () => ({ updateOrderExternalId: updateExternalId }));
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, credentialsFor: async () => ({ apiKey: "k", apiSecret: "s" }) };
});

const { createShipstationOrder } = await import("./create-order");

const COMPANY = {
  id: 1n,
  name: "Acme",
  fluidCompanyId: 42n,
  authenticationToken: "cat_acme",
};

const SETTING = {
  id: 7n,
  companyId: 1n,
  holdForBatch: false,
  batchWindowMinutes: null,
  apiVersion: "v1",
  storeId: null,
  settings: null,
};

function localOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 10n,
    companyId: 1n,
    fluidOrderId: 555n,
    fluidOrderNumber: "SO-1",
    shipstationOrderId: null,
    status: "PENDING",
    retryCount: 0,
    holdUntil: null,
    trackingNumbers: [],
    requestPayload: {},
    ...overrides,
  };
}

const ORDER = {
  id: 555,
  order_number: "SO-1",
  status: "awaiting_shipment",
  ship_to: { name: "Jo", address1: "1 Main St", city: "Austin", state: "TX" },
  items: [{ id: 1, sku: "SKU", title: "Widget", quantity: 2, price: "9.99" }],
  metadata: { shipping: { title: "Ground Shipping" } },
};

const input = (overrides: Record<string, unknown> = {}) => ({
  order: { ...ORDER, ...overrides },
  company_id: 42,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.company.findFirst.mockResolvedValue(COMPANY);
  mockPrisma.integrationSetting.findUnique.mockResolvedValue(SETTING);
  mockPrisma.shippingMethodMapping.findFirst.mockResolvedValue(null);
  mockPrisma.seenShippingMethod.findFirst.mockResolvedValue(null);
  mockPrisma.seenShippingMethod.create.mockResolvedValue({});
  mockPrisma.shipstationOrder.update.mockImplementation(async ({ data }) => ({
    ...localOrder(),
    ...data,
  }));
  // The row lock is a raw statement inside an interactive transaction; here the
  // transaction just runs its callback.
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(mockPrisma),
  );
  mockPrisma.$queryRaw.mockResolvedValue([]);
  isShipped.mockResolvedValue(false);
  vi.stubGlobal("fetch", vi.fn());
});

/** A createorder response. */
function shipstationAccepts(orderId = 987) {
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ orderId }), { status: 200 }),
  );
}

describe("never modifying a labeled order", () => {
  it("does not re-push a changed order once ShipStation has labeled it", async () => {
    // Already SUBMITTED, with a payload that differs from the incoming one.
    const existing = localOrder({
      status: "SUBMITTED",
      shipstationOrderId: "987",
      requestPayload: { ...ORDER, ship_to: { name: "Someone Else" } },
    });
    mockPrisma.shipstationOrder.findUnique.mockResolvedValue(existing);
    mockPrisma.shipstationOrder.findUniqueOrThrow.mockResolvedValue(existing);
    isShipped.mockResolvedValue(true);

    const result = await createShipstationOrder(input());

    expect(result.data).toEqual({ skipped: "labeled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does re-push a changed order that is still open", async () => {
    const existing = localOrder({
      status: "SUBMITTED",
      shipstationOrderId: "987",
      requestPayload: { ...ORDER, ship_to: { name: "Someone Else" } },
    });
    mockPrisma.shipstationOrder.findUnique.mockResolvedValue(existing);
    mockPrisma.shipstationOrder.findUniqueOrThrow.mockResolvedValue(existing);
    isShipped.mockResolvedValue(false);
    shipstationAccepts();

    const result = await createShipstationOrder(input());

    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("leaves an unchanged submitted order alone without even asking", async () => {
    const existing = localOrder({
      status: "SUBMITTED",
      shipstationOrderId: "987",
      requestPayload: ORDER,
    });
    mockPrisma.shipstationOrder.findUnique.mockResolvedValue(existing);
    mockPrisma.shipstationOrder.findUniqueOrThrow.mockResolvedValue(existing);

    const result = await createShipstationOrder(input());

    expect(result.data).toEqual({ skipped: "no change" });
    expect(isShipped).not.toHaveBeenCalled();
  });

  it("never touches an order this droplet already knows shipped", async () => {
    const existing = localOrder({ status: "SHIPPED", shipstationOrderId: "987" });
    mockPrisma.shipstationOrder.findUnique.mockResolvedValue(existing);
    mockPrisma.shipstationOrder.findUniqueOrThrow.mockResolvedValue(existing);

    const result = await createShipstationOrder(input());

    expect(result.data).toEqual({ skipped: "already SHIPPED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not cancel a labeled order when Fluid says it is unfulfillable", async () => {
    mockPrisma.shipstationOrder.findFirst.mockResolvedValue(
      localOrder({ status: "SUBMITTED", shipstationOrderId: "987" }),
    );
    cancelOrder.mockResolvedValue("skipped_has_label");

    const result = await createShipstationOrder(input({ status: "cancelled" }));

    expect(result.data).toEqual({ skipped: "status=cancelled" });
    // The local record keeps its status and records why it was left alone.
    const update = mockPrisma.shipstationOrder.update.mock.calls.at(-1)?.[0];
    expect(update.data.status).toBeUndefined();
    expect(update.data.lastError).toContain("already has a label");
  });

  it("does cancel an unfulfillable order that has no label yet", async () => {
    mockPrisma.shipstationOrder.findFirst.mockResolvedValue(
      localOrder({ status: "SUBMITTED", shipstationOrderId: "987" }),
    );
    cancelOrder.mockResolvedValue("cancelled");

    await createShipstationOrder(input({ status: "refunded" }));

    const update = mockPrisma.shipstationOrder.update.mock.calls.at(-1)?.[0];
    expect(update.data.status).toBe("CANCELLED");
  });
});

describe("status gating", () => {
  beforeEach(() => {
    const fresh = localOrder();
    mockPrisma.shipstationOrder.findUnique.mockResolvedValue(null);
    mockPrisma.shipstationOrder.create.mockResolvedValue(fresh);
    mockPrisma.shipstationOrder.findUniqueOrThrow.mockResolvedValue(fresh);
  });

  it("holds an unpaid order instead of sending it", async () => {
    const result = await createShipstationOrder(input({ status: "awaiting_payment" }));

    expect(result.data).toEqual({ held: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("batch-holds when the company has batching on", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue({
      ...SETTING,
      holdForBatch: true,
      batchWindowMinutes: 15,
    });

    const result = await createShipstationOrder(input());

    expect(result.data).toEqual({ held_for_batch: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bypasses the batching hold when told to", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue({
      ...SETTING,
      holdForBatch: true,
    });
    shipstationAccepts();

    const result = await createShipstationOrder(input(), { respectHold: false });

    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("records a 4xx as FAILED without throwing, because a retry cannot fix it", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ Message: "Invalid serviceCode" }), { status: 400 }),
    );

    const result = await createShipstationOrder(input());

    expect(result.success).toBe(false);
    expect(result.error).toBe("ShipStation 400: Invalid serviceCode");
    const update = mockPrisma.shipstationOrder.update.mock.calls.at(-1)?.[0];
    expect(update.data.status).toBe("FAILED");
  });

  it("throws on a 5xx, so the webhook answers 500 and Fluid retries", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("boom", { status: 503 }));

    await expect(createShipstationOrder(input())).rejects.toThrow(/ShipStation error/);
  });
});

describe("the ShipStation payload", () => {
  beforeEach(() => {
    const fresh = localOrder();
    mockPrisma.shipstationOrder.findUnique.mockResolvedValue(null);
    mockPrisma.shipstationOrder.create.mockResolvedValue(fresh);
    mockPrisma.shipstationOrder.findUniqueOrThrow.mockResolvedValue(fresh);
    shipstationAccepts();
  });

  const sentBody = () =>
    JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));

  it("sends the shipping title even with no mapping configured", async () => {
    await createShipstationOrder(input());

    const body = sentBody();
    expect(body.requestedShippingService).toBe("Ground Shipping");
    expect(body.carrierCode).toBeUndefined();
  });

  it("sends carrier and service only as a complete pair", async () => {
    mockPrisma.shippingMethodMapping.findFirst.mockResolvedValue({
      carrierCode: "stamps_com",
      serviceCode: null,
      packageCode: null,
    });

    await createShipstationOrder(input());

    // ShipStation rejects a carrier with no service ("Invalid serviceCode"), so
    // the title alone goes rather than a 400.
    expect(sentBody().carrierCode).toBeUndefined();
  });

  it("assigns the configured store", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue({
      ...SETTING,
      storeId: "12345",
    });

    await createShipstationOrder(input());

    expect(sentBody().advancedOptions).toEqual({ storeId: 12345 });
  });

  it("puts the ordered variant on the line item so the packing slip shows it", async () => {
    await createShipstationOrder(
      input({
        items: [
          {
            id: 1,
            title: "Widget",
            quantity: 1,
            ordered_variant: [{ option_type: "Size", value: "Large" }],
          },
        ],
      }),
    );

    const item = sentBody().items[0];
    expect(item.options).toEqual([{ name: "Size", value: "Large" }]);
    expect(item.name).toBe("Widget — Large");
  });

  it("ignores Fluid's Default Variant placeholder", async () => {
    await createShipstationOrder(
      input({
        items: [
          { id: 1, title: "Widget", quantity: 1, variant: { title: "Default Variant" } },
        ],
      }),
    );

    const item = sentBody().items[0];
    expect(item.options).toBeUndefined();
    expect(item.name).toBe("Widget");
  });

  it("converts a kg weight to grams and omits an absent one", async () => {
    await createShipstationOrder(
      input({
        items: [
          { id: 1, title: "A", quantity: 1, weight: 1.5, unit_of_weight: "kg" },
          { id: 2, title: "B", quantity: 1 },
        ],
      }),
    );

    const items = sentBody().items;
    expect(items[0].weight).toEqual({ value: 1500, units: "grams" });
    expect(items[1].weight).toBeUndefined();
  });
});

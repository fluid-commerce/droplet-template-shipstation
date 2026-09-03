/**
 * Fluid commerce calls.
 *
 * The Rails services these port from tested `parsed.blank? || parsed[:error]`.
 * `blank?` is not JS truthiness: `{}` and `[]` are blank in Ruby and truthy in
 * JS, and a Fluid failure that answers `{}` must not read as a completed
 * fulfillment — the caller sets tracking_synced_to_fluid on success and the
 * order is then never retried.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { createOrderFulfillment, retrieveOrder } from "./index";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

const responds = (body: string, status = 200) =>
  vi.mocked(fetch).mockResolvedValue(new Response(body, { status }));

describe("retrieveOrder", () => {
  it("returns the order", async () => {
    responds(JSON.stringify({ order: { id: 1, items: [] } }));
    await expect(retrieveOrder("tok", 1)).resolves.toEqual({
      order: { id: 1, items: [] },
    });
  });

  it("treats an empty object as no order, as Rails' blank? did", async () => {
    responds("{}");
    await expect(retrieveOrder("tok", 1)).resolves.toBeNull();
  });

  it("treats an error body as no order", async () => {
    responds(JSON.stringify({ error: "nope" }));
    await expect(retrieveOrder("tok", 1)).resolves.toBeNull();
  });
});

describe("createOrderFulfillment", () => {
  const call = () =>
    createOrderFulfillment("tok", {
      id: 1,
      orderItems: [{ id: 9, quantity: 1 }],
      trackingInformations: [{ tracking_number: "1Z" }],
    });

  it("returns the fulfillment on success", async () => {
    responds(JSON.stringify({ order_fulfillment: { id: 5 } }));
    await expect(call()).resolves.toEqual({ order_fulfillment: { id: 5 } });
  });

  it("throws on an empty object, so the sync is retried", async () => {
    responds("{}");
    await expect(call()).rejects.toThrow(/Failed to fulfill order 1/);
  });

  it("throws on an empty array", async () => {
    responds("[]");
    await expect(call()).rejects.toThrow(/Failed to fulfill order 1/);
  });

  it("throws on an error body", async () => {
    responds(JSON.stringify({ error: "boom" }));
    await expect(call()).rejects.toThrow(/Failed to fulfill order 1/);
  });
});

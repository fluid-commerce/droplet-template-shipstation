import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { FluidClient, FluidAuthenticationError } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("FluidClient", () => {
  it("forwards page and per_page on listCallbacks", async () => {
    // The endpoint is company-scoped and defaults to 10 per page. A client that
    // drops these silently sees only the first ten of a list that also contains
    // other droplets' registrations — so a backfill adopts a fraction of what
    // it should, and every later callback is refused.
    fetchMock.mockResolvedValue(jsonResponse({ callback_registrations: [] }));

    const client = new FluidClient("token", "https://api.fluid.test");
    await client.listCallbacks({ page: 3, per_page: 100 });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.fluid.test/api/callback/registrations?page=3&per_page=100",
    );
  });

  it("pages listAllWebhooks to the end and returns every webhook", async () => {
    // The bug this covers reached production twice. GET /api/company/webhooks
    // pages at 30 by default and the listing is COMPANY-scoped, so an active
    // company carries a webhook for every droplet it has installed. A single
    // unpaged call returned 30 of one company's 39 and silently omitted an
    // order.created — a repoint moved two webhooks of three and reported
    // success, and the uninstall cleanup could not find its own subscriptions.
    const page = (n: number, count: number) =>
      jsonResponse({
        webhooks: Array.from({ length: count }, (_, i) => ({
          id: n * 1000 + i,
          resource: "order",
          event: "created",
          url: "https://ours.example.com/api/webhooks",
        })),
      });

    fetchMock
      .mockResolvedValueOnce(page(1, 100))
      .mockResolvedValueOnce(page(2, 100))
      .mockResolvedValueOnce(page(3, 7));

    const client = new FluidClient("token", "https://api.fluid.test");
    const all = await client.listAllWebhooks();

    expect(all).toHaveLength(207);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.fluid.test/api/company/webhooks?page=1&per_page=100",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://api.fluid.test/api/company/webhooks?page=3&per_page=100",
    );
  });

  it("stops after one request when the first page is short", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ webhooks: [{ id: 1, resource: "order", event: "created" }] }),
    );

    const client = new FluidClient("token", "https://api.fluid.test");
    expect(await client.listAllWebhooks()).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws at the page cap rather than returning a truncated list", async () => {
    // Refusing loudly matters more than it looks: at every call site a
    // truncated list is indistinguishable from a complete one, so returning
    // what it has would silently under-report and each caller would act on it.
    const full = () =>
      jsonResponse({
        webhooks: Array.from({ length: 2 }, (_, i) => ({ id: i })),
      });
    // mockImplementation, not mockResolvedValue: a Response body can be read
    // once, so handing back the same object on every call fails with "Body has
    // already been read" instead of the assertion under test.
    fetchMock.mockImplementation(async () => full());

    const client = new FluidClient("token", "https://api.fluid.test");
    await expect(client.listAllWebhooks(2, 3)).rejects.toThrow(
      /refusing to act on a list that may be truncated/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("omits the query string entirely when given no params", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ callback_registrations: [] }));

    const client = new FluidClient("token", "https://api.fluid.test");
    await client.listCallbacks();

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.fluid.test/api/callback/registrations",
    );
  });

  it("does not share credentials between instances", async () => {
    // The Ruby client set its Authorization header on the HTTParty CLASS, so
    // constructing a second FluidClient replaced the first one's token and a
    // request meant for company A went out as company B.
    // A fresh Response each call: a Response body can only be read once.
    fetchMock.mockImplementation(async () =>
      jsonResponse({ callback_registrations: [] }),
    );

    const a = new FluidClient("token-a", "https://api.fluid.test");
    const b = new FluidClient("token-b", "https://api.fluid.test");

    await b.listCallbacks();
    await a.listCallbacks();

    const headersOf = (call: number) =>
      (fetchMock.mock.calls[call][1] as RequestInit).headers as Record<
        string,
        string
      >;

    expect(headersOf(0).Authorization).toBe("Bearer token-b");
    expect(headersOf(1).Authorization).toBe("Bearer token-a");
  });

  it("raises a typed error for a 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "nope" }, 401));

    const client = new FluidClient("token", "https://api.fluid.test");
    await expect(client.listCallbacks()).rejects.toBeInstanceOf(
      FluidAuthenticationError,
    );
  });

  it("posts callback registrations to /api/callback/registrations", async () => {
    // /api/company/callbacks does not exist in Fluid. The callback endpoints
    // live under /api/callback/*; see config/routes/integrations.rb.
    fetchMock.mockResolvedValue(
      jsonResponse({
        callback_registration: {
          uuid: "cbr_1",
          definition_name: "cart_item_added",
          url: "https://droplet.test/api/callbacks/cart-item-added",
        },
      }),
    );

    const client = new FluidClient("token", "https://api.fluid.test");
    await client.createCallback({
      definition_name: "cart_item_added",
      url: "https://droplet.test/api/callbacks/cart-item-added",
      timeout_in_seconds: 20,
      active: true,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.fluid.test/api/callback/registrations",
    );
    const body = JSON.parse(
      String((fetchMock.mock.calls[0][1] as RequestInit).body),
    );
    expect(body.callback_registration.definition_name).toBe("cart_item_added");
  });

  it("tolerates a 204 with no body on delete", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const client = new FluidClient("token", "https://api.fluid.test");
    await expect(client.deleteCallback("cbr_1")).resolves.toBeUndefined();
  });
});

/**
 * The ShipStation "shipped" endpoint.
 *
 * Nothing signs this request, so the only thing standing between the caller and
 * a fetch made with a company's ShipStation credentials is the shared token and
 * the resource_url host check. Both are tested here.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { companyFixture } from "@/test/factories";

const mockPrisma = vi.hoisted(() => ({
  company: { findFirst: vi.fn() },
}));
const syncShipped = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));
vi.mock("@/lib/shipstation/sync-shipped-order", () => ({
  syncShippedOrder: syncShipped,
}));

const { POST } = await import("./route");

const GOOD_URL = "https://ssapi.shipstation.com/shipments?batchId=abc";

function request(
  body: unknown,
  headers: Record<string, string> = { "auth-token": "wvt_acme" },
) {
  return new Request("https://droplet.test/api/webhooks/shipped", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.company.findFirst.mockResolvedValue(companyFixture());
});

describe("POST /api/webhooks/shipped", () => {
  it("accepts a request bearing the company's own webhook token", async () => {
    const response = await POST(request({ resource_url: GOOD_URL, company_id: 42 }));

    expect(response.status).toBe(202);
    expect(syncShipped).toHaveBeenCalledWith(GOOD_URL, 1n);
  });

  it("accepts the droplet-wide bootstrap token too, as Rails did", async () => {
    const response = await POST(
      request({ resource_url: GOOD_URL, company_id: 42 }, {
        "auth-token": "test-webhook-token",
      }),
    );

    expect(response.status).toBe(202);
  });

  it("rejects a non-numeric company_id instead of raising", async () => {
    // Reached before authentication, so an unhandled BigInt() SyntaxError here
    // would be an unauthenticated 500.
    const response = await POST(
      request({ resource_url: GOOD_URL, company_id: "not-a-number" }),
    );

    expect(response.status).toBe(400);
    expect(syncShipped).not.toHaveBeenCalled();
  });

  it("refuses a request with no token", async () => {
    const response = await POST(request({ resource_url: GOOD_URL, company_id: 42 }, {}));

    expect(response.status).toBe(401);
    expect(syncShipped).not.toHaveBeenCalled();
  });

  it("refuses a request with the wrong token", async () => {
    const response = await POST(
      request({ resource_url: GOOD_URL, company_id: 42 }, { "auth-token": "guess" }),
    );

    expect(response.status).toBe(401);
  });

  it("refuses a resource_url that is not a ShipStation host — before any lookup", async () => {
    const response = await POST(
      request({
        resource_url: "https://attacker.example/shipments?batchId=abc",
        company_id: 42,
      }),
    );

    expect(response.status).toBe(400);
    expect(mockPrisma.company.findFirst).not.toHaveBeenCalled();
  });

  it("refuses plain http even on a ShipStation host", async () => {
    const response = await POST(
      request({
        resource_url: "http://ssapi.shipstation.com/shipments?batchId=abc",
        company_id: 42,
      }),
    );

    expect(response.status).toBe(400);
  });

  it("looks the company up by fluid_company_id only, never by primary key", async () => {
    await POST(request({ resource_url: GOOD_URL, company_id: 42 }));

    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith({
      where: { fluidCompanyId: 42n },
    });
  });

  it("requires both resource_url and company_id", async () => {
    expect((await POST(request({ resource_url: GOOD_URL }))).status).toBe(400);
    expect((await POST(request({ company_id: 42 }))).status).toBe(400);
  });

  it("answers 500 when the sync fails, so the caller can retry", async () => {
    syncShipped.mockRejectedValueOnce(new Error("ShipStation down"));

    const response = await POST(request({ resource_url: GOOD_URL, company_id: 42 }));

    expect(response.status).toBe(500);
  });
});

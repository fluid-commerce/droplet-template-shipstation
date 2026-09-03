/**
 * DRI authentication for the embedded UI's endpoints.
 *
 * The DRI is the only thing that identifies the installation, so these tests
 * pin the two properties that keep an endpoint from becoming a cross-tenant
 * read: the company comes from the DRI (never from a caller-supplied id), and a
 * request a cross-site form could make is refused.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({ company: { findFirst: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));

const { withDri } = await import("./dri");

const handler = vi.fn(async () => new Response("ok", { status: 200 }));
const route = withDri<{ dri?: string }>(handler);

const XHR = { "X-Requested-With": "XMLHttpRequest" };

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.company.findFirst.mockResolvedValue({ id: 1n, name: "Acme" });
});

describe("withDri", () => {
  it("resolves the company from the query-string DRI", async () => {
    const response = await route(
      new Request("https://droplet.test/api/orders?dri=dri_acme", { headers: XHR }),
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith({
      where: { dropletInstallationUuid: "dri_acme", active: true },
    });
  });

  it("resolves it from the JSON body for a mutation", async () => {
    await route(
      new Request("https://droplet.test/api/orders", {
        method: "POST",
        headers: { ...XHR, "content-type": "application/json" },
        body: JSON.stringify({ dri: "dri_acme" }),
      }),
    );

    expect(mockPrisma.company.findFirst).toHaveBeenCalledWith({
      where: { dropletInstallationUuid: "dri_acme", active: true },
    });
  });

  it("refuses a request without the XHR header a cross-site form cannot set", async () => {
    const response = await route(
      new Request("https://droplet.test/api/orders?dri=dri_acme"),
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses a request with no DRI at all", async () => {
    const response = await route(
      new Request("https://droplet.test/api/orders", { headers: XHR }),
    );

    expect(response.status).toBe(401);
  });

  it("refuses a DRI that does not resolve to an active installation", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const response = await route(
      new Request("https://droplet.test/api/orders?dri=dri_unknown", { headers: XHR }),
    );

    expect(response.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("never reads a company id out of the request", async () => {
    await route(
      new Request("https://droplet.test/api/orders?dri=dri_acme&company_id=99", {
        headers: XHR,
      }),
    );

    const where = mockPrisma.company.findFirst.mock.calls[0][0].where;
    expect(where).not.toHaveProperty("fluidCompanyId");
    expect(where).not.toHaveProperty("id");
  });
});

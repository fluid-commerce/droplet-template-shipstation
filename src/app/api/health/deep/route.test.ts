/**
 * The deep health check is a CUTOVER GATE, so the cases that matter are the
 * ones where it could answer 200 while the company being moved cannot actually
 * be served. Both were live defects found in review before this shipped:
 *
 *  - an unscoped aggregate answering 200 off ANOTHER tenant's healthy row while
 *    the company being repointed had no settings row at all, and
 *  - a partially-configured blob counting as "decryptable" because it had at
 *    least one key, then sending `Basic key:` to ShipStation.
 *
 * Both reproduce the shape that took nuvamed down on 2026-09-08: reachable,
 * verifying, and unable to do the job.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  company: { findFirst: vi.fn(), findMany: vi.fn() },
  integrationSetting: { findUnique: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));

const { GET } = await import("./route");

const AUTH = { authorization: "Bearer test-cron-secret" };

function request(query = "", headers: Record<string, string> = AUTH) {
  return new Request(`https://droplet.test/api/health/deep${query}`, { headers });
}

/** A plaintext settings blob — secretsOf tolerates these, see its doc comment. */
const v1Complete = { apiVersion: "v1", settings: { api_key: "k", api_secret: "s" } };
const v1KeyOnly = { apiVersion: "v1", settings: { api_key: "k" } };
const v2Complete = { apiVersion: "v2", settings: { v2_api_key: "v2k" } };

/**
 * The scoped branch resolves the company twice — once by handle, once the way
 * the order path does — so the default double returns the same row for both.
 */
function scopedCompany(row: Record<string, unknown> = {}) {
  const company = { id: 1n, active: true, fluidCompanyId: 42n, ...row };
  mockPrisma.company.findFirst.mockResolvedValue(company);
  return company;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
});

describe("GET /api/health/deep", () => {
  it("refuses an unauthenticated caller", async () => {
    const response = await GET(request("", {}));
    expect(response.status).toBe(401);
    expect(mockPrisma.company.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.company.findMany).not.toHaveBeenCalled();
  });

  it("reports healthy for a company whose settings decrypt and are usable", async () => {
    scopedCompany();
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(v1Complete);

    const response = await GET(request("?company=nuvamed.fluid.app"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.scoped).toBe(true);
    expect(body.company).toBe("nuvamed.fluid.app");
  });

  it("fails when the NAMED company has no settings row, even though another company is healthy", async () => {
    // The aggregate bug, exactly: sibling tenants are fine, this one is not.
    scopedCompany();
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(null);

    const response = await GET(request("?company=nuvamed.fluid.app"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no integration_settings row/);
  });

  it("fails when the named company does not exist", async () => {
    mockPrisma.company.findFirst.mockResolvedValue(null);

    const response = await GET(request("?company=typo.fluid.app"));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/no company matches/);
  });

  it("fails when the named company is not active", async () => {
    mockPrisma.company.findFirst.mockResolvedValue({ id: 1n, active: false });

    const response = await GET(request("?company=gone.fluid.app"));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/not active/);
  });

  it("fails a v1 company holding an api_key but no api_secret", async () => {
    // Decrypts fine. v1Headers would send `Basic k:`, which ShipStation 401s on
    // every order — so this must NOT count as healthy.
    scopedCompany();
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(v1KeyOnly);

    const response = await GET(request("?company=nuvamed.fluid.app"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.integrationSettings.unusable).toBe(1);
    expect(body.integrationSettings.decryptable).toBe(0);
  });

  it("fails a v2 company holding only a v2_api_key, because the order path is v1-only", async () => {
    // createShipstationOrder POSTs with v1Headers unconditionally and never
    // consults api_version, so v2-only credentials submit `Basic :`. Calling
    // this healthy would cut over a company whose orders cannot land.
    scopedCompany();
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(v2Complete);

    const response = await GET(request("?company=nuvamed.fluid.app"));
    expect(response.status).toBe(503);
    expect((await response.json()).integrationSettings.unusable).toBe(1);
  });

  it("accepts a v2-flagged company that still holds the v1 pair the order path uses", async () => {
    scopedCompany();
    mockPrisma.integrationSetting.findUnique.mockResolvedValue({
      apiVersion: "v2",
      settings: { api_key: "k", api_secret: "s" },
    });

    const response = await GET(request("?company=nuvamed.fluid.app"));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });

  it("fails when fluid_company_id resolves to a different row than the shop does", async () => {
    // fluid_company_id is indexed but not unique, and the order path resolves by
    // it with an unordered findFirst -- so a duplicate would serve this
    // company's orders from another company's ShipStation credentials.
    mockPrisma.company.findFirst
      .mockResolvedValueOnce({ id: 1n, active: true, fluidCompanyId: 42n })
      .mockResolvedValueOnce({ id: 2n, active: true, fluidCompanyId: 42n });

    const response = await GET(request("?company=nuvamed.fluid.app"));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/different row by fluid_company_id/);
    expect(mockPrisma.integrationSetting.findUnique).not.toHaveBeenCalled();
  });

  it("asks for the settings row WITHOUT a select, so a drifted column still throws", async () => {
    // The regression this guards: narrowing the query to the fields this route
    // reads would stop a phantom column from throwing here while the order
    // path's unqualified findUnique still failed on it.
    scopedCompany();
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(v1Complete);

    await GET(request("?company=nuvamed.fluid.app"));

    const call = mockPrisma.integrationSetting.findUnique.mock.calls[0][0];
    expect(call.select).toBeUndefined();
    expect(mockPrisma.company.findFirst.mock.calls[0][0].select).toBeUndefined();
  });

  it("marks itself unscoped when asked without a company, so a caller cannot mistake it for a per-company answer", async () => {
    mockPrisma.company.findMany.mockResolvedValue([{ id: 1n }]);
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(v1Complete);

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.scoped).toBe(false);
    expect(body.company).toBeNull();
  });

  it("is not healthy when no company has settings at all", async () => {
    mockPrisma.company.findMany.mockResolvedValue([{ id: 1n }]);
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(null);

    const response = await GET(request());
    expect(response.status).toBe(503);
    expect((await response.json()).ok).toBe(false);
  });

  it("reports the failing query rather than throwing when the schema has drifted", async () => {
    // The nuvamed failure itself.
    scopedCompany();
    mockPrisma.integrationSetting.findUnique.mockRejectedValue(
      new Error(
        "The column integration_settings.credentials does not exist in the current database.\nmore",
      ),
    );

    const response = await GET(request("?company=nuvamed.fluid.app"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error).toBe(
      "The column integration_settings.credentials does not exist in the current database.",
    );
  });
});

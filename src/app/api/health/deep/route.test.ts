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
    mockPrisma.company.findFirst.mockResolvedValue({ id: 1n, active: true });
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
    mockPrisma.company.findFirst.mockResolvedValue({ id: 1n, active: true });
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
    mockPrisma.company.findFirst.mockResolvedValue({ id: 1n, active: true });
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(v1KeyOnly);

    const response = await GET(request("?company=nuvamed.fluid.app"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.integrationSettings.unusable).toBe(1);
    expect(body.integrationSettings.decryptable).toBe(0);
  });

  it("accepts a v2 company holding only a v2_api_key", async () => {
    // The v1 pair is irrelevant on v2 — requiring it would fail a healthy company.
    mockPrisma.company.findFirst.mockResolvedValue({ id: 1n, active: true });
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(v2Complete);

    const response = await GET(request("?company=nuvamed.fluid.app"));
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });

  it("fails a v2 company holding only the v1 pair", async () => {
    mockPrisma.company.findFirst.mockResolvedValue({ id: 1n, active: true });
    mockPrisma.integrationSetting.findUnique.mockResolvedValue({
      apiVersion: "v2",
      settings: { api_key: "k", api_secret: "s" },
    });

    const response = await GET(request("?company=nuvamed.fluid.app"));
    expect(response.status).toBe(503);
    expect((await response.json()).integrationSettings.unusable).toBe(1);
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
    mockPrisma.company.findFirst.mockResolvedValue({ id: 1n, active: true });
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

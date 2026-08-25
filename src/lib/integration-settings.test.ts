/**
 * Per-company settings.
 *
 * The rule under test throughout: a save only changes what the caller actually
 * sent. Secrets are never sent back to the browser, so a blank field means "keep
 * the stored value" — and a batching-only or store-only save must not wipe the
 * credentials it never had.
 */

import type { Prisma } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  integrationSetting: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
}));

vi.mock("@/lib/db", () => ({ prisma: mockPrisma, default: mockPrisma }));

process.env.ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY =
  "test_deterministic_key_0123456789";
process.env.ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT =
  "test_key_derivation_salt_01234567";

const {
  IntegrationSettingValidationError,
  encodeSecrets,
  isSandboxKey,
  saveIntegrationSetting,
  secretsOf,
} = await import("./integration-settings");

const stored = (secrets: Record<string, string>) => ({
  id: 7n,
  companyId: 1n,
  settings: encodeSecrets(secrets) as unknown as Prisma.JsonValue,
  holdForBatch: false,
  batchWindowMinutes: null,
  apiVersion: "v1",
  storeId: null,
});

/** The `settings` value the last write would have persisted, decrypted. */
const written = () => {
  const call =
    mockPrisma.integrationSetting.update.mock.calls.at(-1) ??
    mockPrisma.integrationSetting.create.mock.calls.at(-1);
  return secretsOf({ settings: call?.[0].data.settings });
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.integrationSetting.update.mockResolvedValue({});
  mockPrisma.integrationSetting.create.mockResolvedValue({});
});

describe("secretsOf", () => {
  it("decrypts an Active Record envelope", () => {
    expect(secretsOf(stored({ api_key: "KEY" }))).toEqual({ api_key: "KEY" });
  });

  it("still reads a row that was never encrypted", () => {
    expect(secretsOf({ settings: { api_key: "KEY" } })).toEqual({ api_key: "KEY" });
  });

  it("is empty rather than throwing for a row it cannot read", () => {
    expect(secretsOf(null)).toEqual({});
  });
});

describe("saveIntegrationSetting", () => {
  it("keeps a stored secret when the field comes back blank", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(
      stored({ api_key: "KEY", api_secret: "SECRET" }),
    );

    await saveIntegrationSetting(1n, { secrets: { api_key: "" } });

    expect(written()).toEqual({ api_key: "KEY", api_secret: "SECRET" });
  });

  it("replaces a secret the admin actually typed", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(
      stored({ api_key: "KEY", api_secret: "SECRET" }),
    );

    await saveIntegrationSetting(1n, { secrets: { api_key: "NEW" } });

    expect(written()).toEqual({ api_key: "NEW", api_secret: "SECRET" });
  });

  it("does not touch credentials on a batching-only save", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(
      stored({ api_key: "KEY", api_secret: "SECRET" }),
    );

    await saveIntegrationSetting(1n, { holdForBatch: true });

    expect(written()).toEqual({ api_key: "KEY", api_secret: "SECRET" });
    const data = mockPrisma.integrationSetting.update.mock.calls[0][0].data;
    expect(data.holdForBatch).toBe(true);
    expect(data.apiVersion).toBeUndefined();
    expect(data.storeId).toBeUndefined();
  });

  it("creates the row when a company has none yet", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(null);

    await saveIntegrationSetting(1n, { secrets: { api_key: "KEY" } });

    expect(mockPrisma.integrationSetting.create).toHaveBeenCalled();
    expect(written()).toEqual({ api_key: "KEY" });
  });

  it("clears the store on a blank selection so orders use the default", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(stored({}));

    await saveIntegrationSetting(1n, { storeId: "" });

    expect(mockPrisma.integrationSetting.update.mock.calls[0][0].data.storeId).toBeNull();
  });

  it("rejects an unknown api version", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(stored({}));

    await expect(saveIntegrationSetting(1n, { apiVersion: "v3" })).rejects.toBeInstanceOf(
      IntegrationSettingValidationError,
    );
  });

  it("rejects a zero batch window rather than treating it as manual mode", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(stored({}));

    await expect(
      saveIntegrationSetting(1n, { batchWindowMinutes: 0 }),
    ).rejects.toBeInstanceOf(IntegrationSettingValidationError);
  });

  it("accepts null as manual-release batching", async () => {
    mockPrisma.integrationSetting.findUnique.mockResolvedValue(stored({}));

    await saveIntegrationSetting(1n, { batchWindowMinutes: null });

    expect(
      mockPrisma.integrationSetting.update.mock.calls[0][0].data.batchWindowMinutes,
    ).toBeNull();
  });
});

describe("isSandboxKey", () => {
  it("recognises a TEST_ prefixed V2 key", () => {
    expect(isSandboxKey("TEST_abc")).toBe(true);
    expect(isSandboxKey("abc")).toBe(false);
    expect(isSandboxKey(undefined)).toBe(false);
  });
});

/**
 * Per-company integration settings.
 *
 * Port of app/models/integration_setting.rb plus the parts of
 * IntegrationSettingsController that decide what a save is allowed to change.
 *
 * The `settings` column is Active-Record-encrypted (see src/lib/rails), so it
 * is only ever read through `secretsOf` and written through `writeSecrets`.
 * Nothing else in this app touches the raw column.
 */

import type { IntegrationSetting } from "@prisma/client";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import {
  decryptMessage,
  encryptMessage,
  isEncryptedMessage,
} from "@/lib/rails/encrypted-attribute";

export const API_VERSIONS = ["v1", "v2"] as const;
export type ApiVersion = (typeof API_VERSIONS)[number];

/** The three credentials this droplet stores, all write-only from the browser. */
export interface ShipstationSecrets {
  api_key?: string;
  api_secret?: string;
  v2_api_key?: string;
}

export const SECRET_KEYS: Array<keyof ShipstationSecrets> = [
  "api_key",
  "api_secret",
  "v2_api_key",
];

/**
 * Raised when `settings` holds an Active Record envelope that will not decrypt.
 *
 * This is deliberately NOT swallowed into `{}`. A wrong or rotated encryption
 * key, or a damaged envelope, is not the same thing as "this company has not
 * configured ShipStation yet", and treating it as the latter is how a sibling
 * droplet 401'd every tenant at once without raising. It is worse than that
 * here: `saveIntegrationSetting` merges the new secrets onto whatever it read,
 * so an unreadable row that reads as `{}` would be REWRITTEN as `{}` by the
 * next batching- or store-only save, destroying the stored credentials for
 * good. Rails raises on an unauthenticatable ciphertext; so does this.
 */
export class SettingsDecryptionError extends Error {
  constructor(cause: unknown) {
    super(
      "integration_settings.settings could not be decrypted: " +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "SettingsDecryptionError";
  }
}

/**
 * Decrypts a row's `settings`.
 *
 * Tolerates a plaintext object as well, because a row written before the Rails
 * app turned encryption on — or by a developer with `bin/rails db` — is still a
 * usable row and refusing to read it would take a company's integration down.
 *
 * Throws SettingsDecryptionError when the value IS an Active Record envelope
 * and cannot be read. An absent row, or an absent/empty column, is still `{}`:
 * that genuinely means "not configured".
 */
export function secretsOf(setting: Pick<IntegrationSetting, "settings"> | null): ShipstationSecrets {
  const raw = setting?.settings;
  if (!raw) return {};

  if (isEncryptedMessage(raw)) {
    let plaintext: string;
    try {
      plaintext = decryptMessage(raw);
    } catch (error) {
      console.error(
        "[IntegrationSettings] Could not decrypt settings:",
        error instanceof Error ? error.message : error,
      );
      throw new SettingsDecryptionError(error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (error) {
      throw new SettingsDecryptionError(error);
    }

    return parsed && typeof parsed === "object" ? (parsed as ShipstationSecrets) : {};
  }

  return typeof raw === "object" ? (raw as ShipstationSecrets) : {};
}

/**
 * Encrypts a secrets object into the envelope Rails expects.
 *
 * Only Rails' ability to DECRYPT this matters — it re-parses the JSON. Byte
 * equality with Ruby's `JSON.generate` would only matter for a
 * `where(settings: …)` lookup, and nothing in either app does one.
 */
export function encodeSecrets(secrets: ShipstationSecrets): Prisma.InputJsonValue {
  return encryptMessage(JSON.stringify(secrets)) as unknown as Prisma.InputJsonValue;
}

export function isV2(setting: Pick<IntegrationSetting, "apiVersion"> | null): boolean {
  return setting?.apiVersion === "v2";
}

/** ShipStation V2/ShipEngine sandbox keys are prefixed "TEST_". */
export function isSandboxKey(key: string | undefined): boolean {
  return (key ?? "").startsWith("TEST_");
}

export function findIntegrationSetting(companyId: bigint) {
  return prisma.integrationSetting.findUnique({ where: { companyId } });
}

export interface IntegrationSettingPatch {
  /** Only the keys the caller actually sent; a blank value never overwrites. */
  secrets?: ShipstationSecrets;
  holdForBatch?: boolean;
  batchWindowMinutes?: number | null;
  apiVersion?: string;
  storeId?: string | null;
}

export class IntegrationSettingValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(", "));
    this.name = "IntegrationSettingValidationError";
  }
}

/**
 * Upserts a company's integration settings.
 *
 * Every field is optional and absent means "leave it alone", which is what
 * makes a credentials-only save safe next to a batching-only save. Secrets go
 * further: a key present but blank is also ignored, because the browser is
 * never sent the stored value and a blank field means "keep it".
 */
export async function saveIntegrationSetting(
  companyId: bigint,
  patch: IntegrationSettingPatch,
): Promise<IntegrationSetting> {
  const existing = await findIntegrationSetting(companyId);
  const errors: string[] = [];

  if (patch.apiVersion !== undefined && !API_VERSIONS.includes(patch.apiVersion as ApiVersion)) {
    errors.push("Api version is not included in the list");
  }
  // nil = manual-release batching (hold until an explicit send); a positive
  // window auto-releases. Zero/negative are rejected rather than silently
  // treated as manual mode.
  if (
    patch.batchWindowMinutes !== undefined &&
    patch.batchWindowMinutes !== null &&
    !(Number.isFinite(patch.batchWindowMinutes) && patch.batchWindowMinutes > 0)
  ) {
    errors.push("Batch window minutes must be greater than 0");
  }
  if (errors.length > 0) throw new IntegrationSettingValidationError(errors);

  // Reads the stored secrets before merging. If the column will not decrypt
  // this THROWS and the write never happens — the alternative is merging onto
  // `{}` and persisting an empty envelope over the real credentials.
  const merged = { ...secretsOf(existing) };
  for (const key of SECRET_KEYS) {
    const value = patch.secrets?.[key];
    if (value) merged[key] = value;
  }

  const data = {
    settings: encodeSecrets(merged),
    ...(patch.holdForBatch !== undefined ? { holdForBatch: patch.holdForBatch } : {}),
    ...(patch.batchWindowMinutes !== undefined
      ? { batchWindowMinutes: patch.batchWindowMinutes }
      : {}),
    ...(patch.apiVersion !== undefined ? { apiVersion: patch.apiVersion } : {}),
    ...(patch.storeId !== undefined ? { storeId: patch.storeId || null } : {}),
  };

  return existing
    ? prisma.integrationSetting.update({ where: { id: existing.id }, data })
    : prisma.integrationSetting.create({ data: { companyId, ...data } });
}

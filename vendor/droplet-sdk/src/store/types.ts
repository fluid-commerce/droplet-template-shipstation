/**
 * Storage port for callback verification tokens.
 *
 * Deliberately narrow. The SDK owns exactly one table — the one no droplet has
 * today — so there is nothing to remap and no existing data to migrate.
 * Installation and company storage stay app-owned, because every droplet
 * already has a working version under a different model name.
 */

export interface StoredRegistration {
  /** Fluid's `cbr_` registration uuid. */
  uuid: string;
  /** droplet_installation_uuid (`dri_`) this registration belongs to. */
  dri: string;
  /** Which callback definition this registration serves. */
  definitionName: string;
  /** sha256 of the `cvt_` token. Never the token itself. */
  tokenDigest: string;
  url: string;
}

export interface CallbackTokenStore {
  /** Locate a registration by the digest of a presented token. Must be an indexed lookup. */
  findByTokenDigest(digest: string): Promise<StoredRegistration | null>;

  upsert(registration: StoredRegistration): Promise<void>;
  deleteForInstallation(dri: string): Promise<void>;
}

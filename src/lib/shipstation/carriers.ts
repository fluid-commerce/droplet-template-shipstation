/**
 * Port of app/services/shipstation/carriers.rb.
 *
 * Reads the connected carriers, services, packages and stores from a company's
 * ShipStation account so the config UI can offer dropdowns instead of free-text
 * codes. Every read is best-effort: a missing-credential, auth or network
 * failure returns [] rather than throwing, so the UI degrades to manual entry.
 */

import { credentialsFor, hasV1Credentials, shipstationGet } from "./client";

export interface ShipstationCodeName {
  code?: string;
  name?: string;
  nickname?: string;
}

export interface ShipstationStore {
  storeId?: number | string;
  storeName?: string;
  marketplaceName?: string;
  active?: boolean;
}

async function getList<T>(
  companyId: bigint,
  path: string,
  query: Record<string, string | boolean> = {},
): Promise<T[]> {
  const credentials = await credentialsFor(companyId);
  if (!hasV1Credentials(credentials)) return [];

  try {
    const response = await shipstationGet(path, credentials, query);
    if (response.status !== 200) return [];

    const body: unknown = await response.json();
    return Array.isArray(body) ? (body as T[]) : [];
  } catch (error) {
    console.error(
      "[Shipstation::Carriers]",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

export function listCarriers(companyId: bigint) {
  return getList<ShipstationCodeName>(companyId, "/carriers");
}

export function listServices(companyId: bigint, carrierCode: string) {
  if (!carrierCode) return Promise.resolve([] as ShipstationCodeName[]);
  return getList<ShipstationCodeName>(companyId, "/carriers/listservices", {
    carrierCode,
  });
}

export function listPackages(companyId: bigint, carrierCode: string) {
  if (!carrierCode) return Promise.resolve([] as ShipstationCodeName[]);
  return getList<ShipstationCodeName>(companyId, "/carriers/listpackages", {
    carrierCode,
  });
}

/** The stores an order can be assigned to (advancedOptions.storeId). */
export function listStores(companyId: bigint) {
  return getList<ShipstationStore>(companyId, "/stores", { showInactive: false });
}

/**
 * Port of app/services/shipstation/test_connection.rb and
 * app/services/shipstation/v2/test_connection.rb.
 *
 * Verifies a company's stored credentials with an authenticated read-only
 * request. Both return "not connected" rather than throwing, because this is a
 * button in the config UI, not a decision the order path depends on.
 */

import { isSandboxKey } from "@/lib/integration-settings";

import {
  SHIPSTATION_V2_API_BASE,
  credentialsFor,
  hasV1Credentials,
  shipstationGet,
  v2Headers,
} from "./client";

export async function testV1Connection(companyId: bigint): Promise<boolean> {
  const credentials = await credentialsFor(companyId);
  if (!hasV1Credentials(credentials)) return false;

  try {
    const response = await shipstationGet("/carriers", credentials);
    return response.status === 200;
  } catch (error) {
    console.error(
      "[Shipstation::TestConnection]",
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export interface V2ConnectionResult {
  connected: boolean;
  /** Which environment the stored key targets, so the UI can say so. */
  sandbox: boolean;
}

export async function testV2Connection(companyId: bigint): Promise<V2ConnectionResult> {
  const { v2ApiKey } = await credentialsFor(companyId);
  const sandbox = isSandboxKey(v2ApiKey);

  if (!v2ApiKey) return { connected: false, sandbox };

  try {
    const response = await fetch(`${SHIPSTATION_V2_API_BASE}/carriers`, {
      headers: v2Headers(v2ApiKey),
    });
    return { connected: response.status === 200, sandbox };
  } catch (error) {
    console.error(
      "[Shipstation::V2::TestConnection]",
      error instanceof Error ? error.message : error,
    );
    return { connected: false, sandbox };
  }
}

/**
 * Port of app/services/shipstation/order_status.rb.
 *
 * Answers whether a ShipStation order has already shipped / been labeled, which
 * is what decides if a Fluid-side edit may be re-pushed. Fail-safe by design: on
 * any error or ambiguity it reports `true`, so we DON'T overwrite an order we
 * cannot confirm is still open.
 */

import { credentialsFor, hasV1Credentials, shipstationGet } from "./client";

export async function isShipstationOrderShipped(
  companyId: bigint,
  shipstationOrderId: string | null,
): Promise<boolean> {
  if (!shipstationOrderId) return false;

  const credentials = await credentialsFor(companyId);
  if (!hasV1Credentials(credentials)) return false;

  try {
    const response = await shipstationGet(
      `/orders/${shipstationOrderId}`,
      credentials,
    );
    // Unsure -> treat as labeled, skip the update.
    if (response.status !== 200) return true;

    const body = (await response.json()) as { orderStatus?: string };
    return body.orderStatus === "shipped";
  } catch (error) {
    console.error(
      "[Shipstation::OrderStatus]",
      error instanceof Error ? error.message : error,
    );
    return true;
  }
}

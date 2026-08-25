/**
 * Port of app/services/shipstation/cancel_order.rb.
 *
 * Cancels an order in ShipStation when Fluid reports it is no longer
 * fulfillable — but NEVER touches an order that already has a label or has
 * shipped. In ShipStation, buying or printing a label moves the order to the
 * "shipped" status, so `orderStatus` is the reliable "has a label" signal.
 */

import { credentialsFor, hasV1Credentials, shipstationGet, SHIPSTATION_API_BASE, v1Headers } from "./client";

export type CancelResult =
  /** Order was deleted (soft-cancelled) in ShipStation. */
  | "cancelled"
  /** Order already shipped/labeled; left untouched. */
  | "skipped_has_label"
  /** Order was already cancelled/inactive. */
  | "already_cancelled"
  /** No such order, or missing credentials. */
  | "not_found";

/** ShipStation orderStatuses that mean a label exists — we must not recall these. */
const SHIPPED_STATUSES = ["shipped"];
const CANCELLED_STATUSES = ["cancelled"];

export async function cancelShipstationOrder(
  companyId: bigint,
  shipstationOrderId: string | null,
): Promise<CancelResult> {
  if (!shipstationOrderId) return "not_found";

  const credentials = await credentialsFor(companyId);
  if (!hasV1Credentials(credentials)) return "not_found";

  const response = await shipstationGet(`/orders/${shipstationOrderId}`, credentials);
  if (response.status === 404) return "not_found";
  if (response.status !== 200) {
    throw new Error(`ShipStation order fetch failed (${response.status})`);
  }

  const order = (await response.json()) as { orderStatus?: string };
  if (CANCELLED_STATUSES.includes(order.orderStatus ?? "")) return "already_cancelled";
  if (SHIPPED_STATUSES.includes(order.orderStatus ?? "")) return "skipped_has_label";

  // DELETE performs a ShipStation soft-cancel (marks the order inactive), which
  // removes it from the shipping queue so it won't be fulfilled.
  const deleted = await fetch(
    `${SHIPSTATION_API_BASE}/orders/${shipstationOrderId}`,
    { method: "DELETE", headers: v1Headers(credentials) },
  );
  if (deleted.status !== 200) {
    throw new Error(`ShipStation order cancel failed (${deleted.status})`);
  }

  return "cancelled";
}

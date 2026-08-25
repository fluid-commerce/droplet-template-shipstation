/**
 * Port of app/services/shipstation/shipments.rb.
 *
 * Reads shipments for an order from a company's ShipStation account so the
 * tracking poll can discover when an order shipped — ShipStation pushes no
 * shipment webhook to this droplet, so discovery is a poll.
 */

import {
  RateLimitError,
  SHIPSTATION_API_BASE,
  credentialsFor,
  hasV1Credentials,
  rateLimitedGet,
} from "./client";

export interface ShipstationShipment {
  trackingNumber?: string;
  carrierCode?: string;
  voided?: boolean;
  orderKey?: string;
  orderNumber?: string;
}

/**
 * Every non-voided shipment carrying a tracking number for a ShipStation order
 * id — an order can ship in several packages, each with its own number. Walks
 * all result pages.
 *
 * Returns [] when the order has not shipped or on a non-rate-limit failure; a
 * persistent 429 re-raises so the caller can back off rather than mistake it
 * for "not shipped".
 */
export async function shipmentsForOrder(
  companyId: bigint,
  shipstationOrderId: string | null,
): Promise<ShipstationShipment[]> {
  if (!shipstationOrderId) return [];

  const credentials = await credentialsFor(companyId);
  if (!hasV1Credentials(credentials)) return [];

  try {
    const shipments = await eachPage(credentials, { orderId: shipstationOrderId });
    return shipments.filter((s) => !s.voided && !!s.trackingNumber);
  } catch (error) {
    if (error instanceof RateLimitError) throw error;
    console.error(
      "[Shipstation::Shipments]",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/** Accumulates the "shipments" array across every page ShipStation returns. */
async function eachPage(
  credentials: Awaited<ReturnType<typeof credentialsFor>>,
  query: Record<string, string>,
): Promise<ShipstationShipment[]> {
  const results: ShipstationShipment[] = [];
  let page = 1;

  for (;;) {
    const response = await rateLimitedGet(`${SHIPSTATION_API_BASE}/shipments`, {
      credentials,
      query: { ...query, page },
    });
    if (response.status !== 200) return results;

    const body = (await response.json()) as {
      shipments?: ShipstationShipment[];
      pages?: number;
    };
    const shipments = body.shipments ?? [];
    results.push(...shipments);

    const totalPages = Number(body.pages ?? 0);
    if (totalPages <= page || shipments.length === 0) break;
    page += 1;
  }

  return results;
}

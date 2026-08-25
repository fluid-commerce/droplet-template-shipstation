/**
 * Port of app/services/shipstation/sync_shipped_order.rb.
 *
 * Handles the ShipStation "shipped" notification, which arrives as a
 * `resource_url` pointing at ShipStation's own /shipments endpoint. We fetch the
 * shipment, record the tracking locally, and push a fulfillment to Fluid.
 *
 * The resource_url is attacker-influenced input — it decides where we send the
 * company's ShipStation credentials — so its host is checked against the
 * ShipStation allowlist before anything else happens.
 */

import { prisma } from "@/lib/db";
import { createOrderFulfillment, retrieveOrder } from "@/lib/fluid-api";

import {
  SHIPSTATION_API_BASE,
  credentialsFor,
  hasV1Credentials,
  isAllowedShipstationUrl,
  v1Headers,
} from "./client";
import type { ShipstationShipment } from "./shipments";

export async function syncShippedOrder(
  resourceUrl: string,
  companyId: bigint,
): Promise<void> {
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) throw new Error(`Company not found for ID: ${companyId}`);

  const credentials = await credentialsFor(companyId);
  if (!hasV1Credentials(credentials)) {
    throw new Error(`Missing API credentials for company: ${companyId}`);
  }

  const batchId = batchIdFrom(resourceUrl);

  const response = await fetch(
    `${SHIPSTATION_API_BASE}/shipments?batchId=${encodeURIComponent(batchId)}`,
    { headers: v1Headers(credentials) },
  );
  if (!response.ok) {
    throw new Error(
      `ShipStation API request failed with status ${response.status}: ${response.statusText}`,
    );
  }

  const body = (await response.json()) as { shipments?: ShipstationShipment[] };
  const shipment = body.shipments?.[0];

  if (!shipment?.orderNumber && !shipment?.orderKey) {
    console.log(
      `[SyncShippedOrder] No order found in ShipStation with batch_id ${batchId}`,
    );
    throw new Error(`No shipment found in ShipStation for batch ${batchId}`);
  }
  if (!shipment.orderKey) {
    throw new Error(`No orderKey in ShipStation shipment for batch ${batchId}`);
  }

  const fluidOrderId = shipment.orderKey;
  const trackingNumber = shipment.trackingNumber ?? null;

  const local = await prisma.shipstationOrder.findFirst({
    where: { companyId, fluidOrderId: BigInt(fluidOrderId) },
  });

  if (local) {
    const tracking = local.trackingNumbers ?? [];
    const updated =
      trackingNumber && !tracking.includes(trackingNumber)
        ? [...tracking, trackingNumber]
        : tracking;

    await prisma.shipstationOrder.update({
      where: { id: local.id },
      data: {
        status: "SHIPPED",
        trackingNumbers: updated,
        carrier: shipment.carrierCode ?? null,
        shippedAt: new Date(),
      },
    });

    // Idempotency guard: skip the Fluid sync if it has already been done.
    if (local.trackingSyncedToFluid) {
      console.log(
        `[SyncShippedOrder] Tracking already synced to Fluid for order ${fluidOrderId}, skipping`,
      );
      return;
    }
  }

  const fluidOrder = await retrieveOrder(company.authenticationToken, fluidOrderId);
  if (!fluidOrder) throw new Error(`Fluid order not found for ID ${fluidOrderId}`);

  await createOrderFulfillment(company.authenticationToken, {
    id: fluidOrder.order?.id ?? fluidOrderId,
    orderItems: fluidOrder.order?.items ?? [],
    trackingInformations: trackingNumber
      ? [{ tracking_number: trackingNumber }]
      : [],
  });

  if (local) {
    await prisma.shipstationOrder.update({
      where: { id: local.id },
      data: { trackingSyncedToFluid: true, trackingSyncedAt: new Date() },
    });
  }

  console.log(`[SyncShippedOrder] Synced tracking to Fluid for order ${fluidOrderId}`);
}

function batchIdFrom(resourceUrl: string): string {
  if (!isAllowedShipstationUrl(resourceUrl)) {
    throw new Error(
      `Invalid resource_url: ${resourceUrl}. Must be an official ShipStation API endpoint.`,
    );
  }

  const batchId = new URL(resourceUrl).searchParams.get("batchId");
  if (!batchId) throw new Error(`No batchId in resource_url: ${resourceUrl}`);
  return batchId;
}

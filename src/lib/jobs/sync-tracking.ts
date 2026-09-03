/**
 * Port of app/jobs/sync_tracking_job.rb.
 *
 * ShipStation does not push a shipment webhook to this droplet (none is
 * registered), so tracking is discovered by POLLING: ask ShipStation whether
 * each submitted order has shipped, record the tracking locally, then push a
 * fulfillment to Fluid. It also retries the Fluid push for any order that has
 * tracking but whose earlier push failed.
 *
 * Rails ran this from Solid Queue's recurring tasks (config/recurring.yml). A
 * standalone Next droplet on Cloud Run has no always-on worker, so it is
 * exposed as a route (src/app/api/jobs/sync-tracking) driven by Cloud
 * Scheduler. Same schedule, same work, no second service.
 */

import { prisma } from "@/lib/db";
import { createOrderFulfillment, retrieveOrder } from "@/lib/fluid-api";
import { RateLimitError, pause } from "@/lib/shipstation/client";
import { shipmentsForOrder } from "@/lib/shipstation/shipments";

const BATCH_SIZE = 100;
/** Orders older than this stop being polled, so stragglers don't poll forever. */
const POLL_WINDOW_DAYS = 30;
/** Space out ShipStation calls to stay under its ~40 req/min/account cap. */
const THROTTLE_SECONDS = process.env.NODE_ENV === "test" ? 0 : 2;

export interface SyncTrackingSummary {
  discovered: number;
  synced: number;
  failed: number;
}

export async function syncTracking(): Promise<SyncTrackingSummary> {
  const discovered = await discoverShippedOrders();
  const { synced, failed } = await pushTrackingToFluid();
  return { discovered, synced, failed };
}

function windowStart(): Date {
  return new Date(Date.now() - POLL_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Ask ShipStation which submitted orders have shipped and record the tracking
 * locally. A newly-SHIPPED order then flows into pushTrackingToFluid below in
 * this same run. Throttled to respect the rate limit; if we still get rate
 * limited, stop this run — the rest are picked up next cycle.
 */
async function discoverShippedOrders(): Promise<number> {
  const orders = await prisma.shipstationOrder.findMany({
    where: {
      status: "SUBMITTED",
      shipstationOrderId: { not: null },
      createdAt: { gte: windowStart() },
    },
    take: BATCH_SIZE,
  });

  let discovered = 0;

  for (const order of orders) {
    if (!order.shipstationOrderId) continue;

    try {
      const shipments = await shipmentsForOrder(
        order.companyId,
        order.shipstationOrderId,
      );
      await pause(THROTTLE_SECONDS);
      if (shipments.length === 0) continue;

      await prisma.shipstationOrder.update({
        where: { id: order.id },
        data: {
          status: "SHIPPED",
          trackingNumbers: [
            ...new Set(
              shipments
                .map((s) => s.trackingNumber)
                .filter((n): n is string => !!n),
            ),
          ],
          carrier: shipments[0].carrierCode ?? null,
          shippedAt: new Date(),
        },
      });
      discovered += 1;
      console.log(
        `[SyncTracking] Discovered ${shipments.length} shipment(s) for ${order.fluidOrderNumber}`,
      );
    } catch (error) {
      if (error instanceof RateLimitError) {
        console.warn(
          `[SyncTracking] Rate limited; stopping this run after ${discovered} discovered: ${error.message}`,
        );
        break;
      }
      console.error(
        `[SyncTracking] Discover failed for order ${order.fluidOrderNumber}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  console.log(`[SyncTracking] Discovered ${discovered} newly-shipped orders`);
  return discovered;
}

async function pushTrackingToFluid(): Promise<{ synced: number; failed: number }> {
  const orders = await prisma.shipstationOrder.findMany({
    where: {
      status: "SHIPPED",
      trackingSyncedToFluid: false,
      trackingNumbers: { isEmpty: false },
      createdAt: { gte: windowStart() },
    },
    include: { company: true },
    take: BATCH_SIZE,
  });

  console.log(`[SyncTracking] Found ${orders.length} orders to sync to Fluid`);

  let synced = 0;
  let failed = 0;

  for (const order of orders) {
    try {
      await syncOrder(order);
      synced += 1;
    } catch (error) {
      console.error(
        `[SyncTracking] Failed to sync order ${order.fluidOrderNumber}:`,
        error instanceof Error ? error.message : error,
      );
      failed += 1;
    }
  }

  console.log(`[SyncTracking] Completed: ${synced} synced, ${failed} failed`);
  return { synced, failed };
}

type OrderWithCompany = Awaited<
  ReturnType<typeof prisma.shipstationOrder.findFirst<{ include: { company: true } }>>
>;

async function syncOrder(order: NonNullable<OrderWithCompany>): Promise<void> {
  const token = order.company?.authenticationToken;
  if (!token) {
    console.warn(
      `[SyncTracking] No authentication token for company on order ${order.fluidOrderNumber}`,
    );
    return;
  }

  const fluidOrder = await retrieveOrder(token, String(order.fluidOrderId));
  if (!fluidOrder) {
    throw new Error(`Fluid order not found for ${order.fluidOrderId}`);
  }

  const trackingNumbers = (order.trackingNumbers ?? []).filter((n) => !!n);
  if (trackingNumbers.length === 0) {
    throw new Error(`No tracking number for order ${order.fluidOrderNumber}`);
  }

  // One tracking_informations entry per package so Fluid records every tracking
  // number, each tagged with the carrier for tracking-link building.
  const carrier = fluidCarrier(order.carrier);

  await createOrderFulfillment(token, {
    id: String(order.fluidOrderId),
    orderItems: fluidOrder.order?.items ?? [],
    trackingInformations: trackingNumbers.map((number) => ({
      tracking_number: number,
      ...(carrier ? { shipping_carrier: carrier } : {}),
    })),
  });

  await prisma.shipstationOrder.update({
    where: { id: order.id },
    data: { trackingSyncedToFluid: true, trackingSyncedAt: new Date() },
  });

  console.log(`[SyncTracking] Synced to Fluid: ${order.fluidOrderNumber}`);
}

/**
 * Normalize a ShipStation carrierCode (fedex, ups_walleted, stamps_com, …) to a
 * carrier name Fluid recognizes for tracking-URL generation. Unknown codes pass
 * through (Fluid simply won't build a URL) rather than being dropped.
 */
export function fluidCarrier(carrierCode: string | null): string | undefined {
  const code = (carrierCode ?? "").toLowerCase();
  if (!code) return undefined;
  if (code.includes("fedex")) return "fedex";
  if (code.includes("ups")) return "ups";
  if (code.includes("usps") || code.includes("stamps") || code.includes("postal")) {
    return "usps";
  }
  if (code.includes("dhl")) return "dhl";
  return carrierCode ?? undefined;
}

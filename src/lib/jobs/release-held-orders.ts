/**
 * Port of app/jobs/release_held_orders_job.rb.
 *
 * Flushes orders held for batching once their window has elapsed. Each order is
 * resubmitted through createShipstationOrder with `respectHold: false` so the
 * batching hold is bypassed — but nothing else is: an order that has since been
 * cancelled, or already sits in ShipStation, still goes down the same gated path.
 *
 * Orders held with no `holdUntil` (manual-release batching) are left for an
 * explicit force-send and are not touched here.
 */

import { prisma } from "@/lib/db";
import {
  createShipstationOrder,
  type FluidOrderPayload,
} from "@/lib/shipstation/create-order";

const BATCH_SIZE = 100;

export interface ReleaseSummary {
  released: number;
  failed: number;
}

export async function releaseHeldOrders(): Promise<ReleaseSummary> {
  const orders = await prisma.shipstationOrder.findMany({
    where: {
      status: "HELD",
      holdUntil: { not: null, lte: new Date() },
    },
    include: { company: true },
    take: BATCH_SIZE,
  });

  console.log(`[ReleaseHeldOrders] Found ${orders.length} orders to release`);

  let released = 0;
  let failed = 0;

  for (const order of orders) {
    try {
      await createShipstationOrder(
        {
          order: (order.requestPayload ?? {}) as unknown as FluidOrderPayload,
          company_id: String(order.company.fluidCompanyId),
        },
        { respectHold: false },
      );
      released += 1;
    } catch (error) {
      console.error(
        `[ReleaseHeldOrders] Failed to release ${order.fluidOrderNumber}:`,
        error instanceof Error ? error.message : error,
      );
      failed += 1;
    }
  }

  console.log(`[ReleaseHeldOrders] Completed: ${released} released, ${failed} failed`);
  return { released, failed };
}

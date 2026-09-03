/**
 * Port of OrdersController#index — the Activity tab.
 *
 * Lists the orders this droplet has tracked for the current company. Scoped by
 * the DRI, so an installation only ever sees its own.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { withDri } from "@/lib/dri";
import { orderJson } from "@/lib/orders";

const RECENT_LIMIT = 100;

export const GET = withDri(async (company) => {
  const orders = await prisma.shipstationOrder.findMany({
    where: { companyId: company.id },
    orderBy: { createdAt: "desc" },
    take: RECENT_LIMIT,
  });

  return NextResponse.json({ orders: orders.map(orderJson) });
});

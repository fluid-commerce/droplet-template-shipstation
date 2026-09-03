/**
 * Port of OrdersController#resend.
 *
 * Resends an order to ShipStation immediately, bypassing the batching hold.
 *
 * Only HELD / FAILED / PENDING orders can be resent. AWAITING_PAYMENT is
 * excluded because `respectHold: false` does not bypass the payment gate — a
 * resend would silently re-hold — and SUBMITTED / SHIPPED / CANCELLED are
 * terminal. That exclusion is also what keeps this button away from an order
 * that may already have a label.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { DriAuthError, requireDriCompany } from "@/lib/dri";
import { isResendable, orderJson } from "@/lib/orders";
import {
  createShipstationOrder,
  type FluidOrderPayload,
} from "@/lib/shipstation/create-order";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  let body: unknown = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  try {
    const company = await requireDriCompany(request, body);
    const { id } = await params;

    const order = await prisma.shipstationOrder.findFirst({
      where: { id: BigInt(id), companyId: company.id },
    });
    if (!order) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (!isResendable(order.status)) {
      return NextResponse.json(
        { error: `Order is ${order.status} and cannot be resent` },
        { status: 422 },
      );
    }

    await createShipstationOrder(
      {
        order: (order.requestPayload ?? {}) as unknown as FluidOrderPayload,
        company_id: String(company.fluidCompanyId),
      },
      { respectHold: false },
    );

    const reloaded = await prisma.shipstationOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    return NextResponse.json(orderJson(reloaded));
  } catch (error) {
    if (error instanceof DriAuthError) return error.response;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to resend order" },
      { status: 422 },
    );
  }
}

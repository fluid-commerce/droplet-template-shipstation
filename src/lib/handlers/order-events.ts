/**
 * Fluid order webhook handlers.
 *
 * Ports app/jobs/order_created_job.rb, order_updated_job.rb and
 * order_shipped_job.rb. All three were thin ActiveJob wrappers around a service;
 * the wrappers are gone and the services are called directly, because these
 * routes run the work inline (see src/lib/events/event-handler.ts).
 *
 * One behaviour the Rails wrapper had that is deliberately NOT reproduced:
 * WebhookEventJob wrapped `process_webhook` in a single database transaction, so
 * a ShipStation rejection that was recorded as FAILED and then re-raised had
 * that FAILED row rolled back — the audit trail vanished exactly when it
 * mattered. Here each write commits on its own.
 */

import { prisma } from "@/lib/db";
import {
  createShipstationOrder,
  type CreateOrderInput,
} from "@/lib/shipstation/create-order";
import { syncShippedOrder } from "@/lib/shipstation/sync-shipped-order";

import { findCompanyForPayload, type CompanyIdentifiers } from "./find-company";

/**
 * Fluid delivers order webhooks either flat or wrapped in a `payload` envelope.
 * Normalise to the inner content so `order` / `company_id` reads work either way.
 */
function unwrap(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const inner = record.payload;
  if (inner && typeof inner === "object" && "resource" in (inner as object)) {
    return inner as Record<string, unknown>;
  }
  return record;
}

function toCreateOrderInput(payload: unknown): CreateOrderInput | null {
  const record = unwrap(payload);
  const order = record.order;
  const companyId =
    record.company_id ??
    (record.company as Record<string, unknown> | undefined)?.fluid_company_id;

  if (!order || typeof order !== "object" || companyId === undefined) return null;

  return {
    order: order as CreateOrderInput["order"],
    company_id: companyId as number | string,
  };
}

/** order.created — push a new order into ShipStation. */
export async function handleOrderCreated(payload: unknown): Promise<void> {
  const input = toCreateOrderInput(payload);
  if (!input) {
    console.warn("[OrderCreated] payload had no order/company_id; ignoring");
    return;
  }
  await createShipstationOrder(input);
}

/**
 * order.updated — and, by the same route, order.cancelled and order.refunded.
 *
 * createShipstationOrder's status gating decides what to do: release a held
 * AWAITING_PAYMENT order once it becomes fulfillable, reconcile a genuine edit
 * on an order already in ShipStation, cancel one Fluid says is no longer
 * fulfillable, or create an order that was never seen via order.created.
 *
 * A partial refund that still ships is therefore left alone: only an actually
 * unfulfillable status reaches the cancel path.
 */
export async function handleOrderUpdated(payload: unknown): Promise<void> {
  const input = toCreateOrderInput(payload);
  if (!input) {
    console.warn("[OrderUpdated] payload had no order/company_id; ignoring");
    return;
  }
  await createShipstationOrder(input);
}

/**
 * order.shipped — a ShipStation-originated notification carrying a
 * `resource_url` that points at ShipStation's own /shipments endpoint.
 */
export async function handleOrderShipped(payload: unknown): Promise<void> {
  const record = unwrap(payload);

  const resourceUrl =
    typeof record.resource_url === "string" ? record.resource_url : null;
  if (!resourceUrl) {
    console.warn("[OrderShipped] payload had no resource_url; ignoring");
    return;
  }

  const company = await resolveCompany(record);
  if (!company) {
    console.warn("[OrderShipped] could not resolve the company; ignoring");
    return;
  }

  await syncShippedOrder(resourceUrl, company.id);
}

async function resolveCompany(record: Record<string, unknown>) {
  const byPayload = await findCompanyForPayload(
    record as unknown as CompanyIdentifiers,
  ).catch(() => null);
  if (byPayload) return byPayload;

  const companyId = record.company_id;
  if (companyId === undefined || companyId === null) return null;

  return prisma.company.findFirst({
    where: { fluidCompanyId: BigInt(companyId as number | string) },
  });
}

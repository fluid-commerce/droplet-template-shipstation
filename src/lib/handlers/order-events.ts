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
  if (!inner || typeof inner !== "object") return record;

  // Rails keyed only off `resource` here. That is not enough for this app:
  // the SDK's `eventOf` also routes the `{ name: "order_created", payload: … }`
  // envelope, whose inner object carries no `resource`. Unwrapping only on
  // `resource` meant such a delivery routed to a handler, found no `order` in
  // the OUTER body, and was acknowledged as handled — a dropped order that
  // Fluid records as a success.
  const envelope = inner as Record<string, unknown>;
  const carriesContent =
    "resource" in envelope || "order" in envelope || "resource_url" in envelope;
  return carriesContent ? envelope : record;
}

/**
 * The tenant the webhook signature verified against.
 *
 * Only `fluid_company_id` is needed here; it is typed structurally so the
 * handlers do not have to import Prisma's Company.
 */
export interface VerifiedCompany {
  id: bigint;
  fluidCompanyId: bigint;
}

function isVerifiedCompany(value: unknown): value is VerifiedCompany {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as VerifiedCompany).fluidCompanyId === "bigint"
  );
}

/**
 * The company an order event is FOR.
 *
 * When the request verified against a company's own secret, that company is
 * the answer and the body cannot override it. A body that names a different
 * company than the one whose secret signed it is a cross-tenant attempt — the
 * signer would otherwise get this droplet to act on another tenant's order
 * using that tenant's ShipStation and Fluid credentials — so it is refused
 * loudly rather than processed against either company.
 *
 * Falling back to the body is only reachable when there is no verified
 * principal at all, which for an order event cannot happen: the route refuses
 * every unverified request, and only the bootstrap lifecycle events may verify
 * without resolving a company.
 */
function companyIdFor(
  record: Record<string, unknown>,
  principal: unknown,
): number | string | undefined {
  const fromPayload = (record.company_id ??
    (record.company as Record<string, unknown> | undefined)?.fluid_company_id) as
    | number
    | string
    | undefined;

  if (!isVerifiedCompany(principal)) return fromPayload;

  const verified = String(principal.fluidCompanyId);
  if (
    fromPayload !== undefined &&
    fromPayload !== null &&
    String(fromPayload) !== verified
  ) {
    throw new Error(
      `webhook names company ${String(fromPayload)} but verified against ${verified}`,
    );
  }

  return verified;
}

function toCreateOrderInput(
  payload: unknown,
  principal: unknown,
): CreateOrderInput | null {
  const record = unwrap(payload);
  const order = record.order;
  const companyId = companyIdFor(record, principal);

  if (!order || typeof order !== "object" || companyId === undefined) return null;

  return {
    order: order as CreateOrderInput["order"],
    company_id: companyId,
  };
}

/** order.created — push a new order into ShipStation. */
export async function handleOrderCreated(
  payload: unknown,
  principal?: unknown,
): Promise<void> {
  const input = toCreateOrderInput(payload, principal);
  if (!input) {
    // Rails raised here (CreateOrder called `nil.deep_symbolize_keys`), so the
    // job failed and was retried. Answering 202 to a payload we could not read
    // would tell Fluid the order was handled and lose it silently.
    throw new Error("[OrderCreated] payload had no order/company_id");
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
export async function handleOrderUpdated(
  payload: unknown,
  principal?: unknown,
): Promise<void> {
  const input = toCreateOrderInput(payload, principal);
  if (!input) {
    throw new Error("[OrderUpdated] payload had no order/company_id");
  }
  await createShipstationOrder(input);
}

/**
 * order.shipped — a ShipStation-originated notification carrying a
 * `resource_url` that points at ShipStation's own /shipments endpoint.
 */
export async function handleOrderShipped(
  payload: unknown,
  principal?: unknown,
): Promise<void> {
  const record = unwrap(payload);

  const resourceUrl =
    typeof record.resource_url === "string" ? record.resource_url : null;
  if (!resourceUrl) {
    throw new Error("[OrderShipped] payload had no resource_url");
  }

  const company = await resolveCompany(record, principal);
  if (!company) {
    throw new Error("[OrderShipped] could not resolve the company");
  }

  await syncShippedOrder(resourceUrl, company.id);
}

async function resolveCompany(
  record: Record<string, unknown>,
  principal: unknown,
) {
  // The verified tenant wins, for the same reason as in companyIdFor: this
  // decides whose ShipStation credentials the resource_url is fetched with.
  if (isVerifiedCompany(principal)) {
    // Throws if the body names a different company; see companyIdFor.
    companyIdFor(record, principal);
    return principal;
  }

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

/**
 * Port of app/services/shipstation/create_order.rb — the heart of this droplet.
 *
 * Takes a Fluid `order.created` / `order.updated` payload and decides what
 * should happen to the matching ShipStation order: submit it, hold it, reconcile
 * an edit, cancel it, or do nothing.
 *
 * The rule that governs all of it, and which every change here has to preserve:
 * **never modify an order that already has a label.** ShipStation moves a
 * labeled order to the "shipped" status, so `orderStatus == "shipped"` is the
 * signal, and both places that could touch a live ShipStation order — the
 * re-push path and the cancel path — check it first and back off.
 */

import type { Prisma, ShipstationOrder } from "@prisma/client";

import { prisma } from "@/lib/db";
import { updateOrderExternalId } from "@/lib/fluid-api";
import { findIntegrationSetting } from "@/lib/integration-settings";

import { cancelShipstationOrder } from "./cancel-order";
import {
  SHIPSTATION_API_BASE,
  credentialsFor,
  v1Headers,
} from "./client";
import { isShipstationOrderShipped } from "./order-status";
import { recordSeenShippingMethod } from "./seen-shipping-methods";

/**
 * Fluid order statuses that are ready to ship. A blank status is treated as
 * fulfillable (older payloads omit it). Anything else that is not awaiting
 * payment is skipped entirely (e.g. cancelled/refunded).
 */
const FULFILLABLE_STATUSES = ["awaiting_shipment"];
const AWAITING_PAYMENT_STATUS = "awaiting_payment";
/** Statuses that mean the order is already in ShipStation — never resend. */
const SUBMITTED_STATUSES = ["SUBMITTED", "SHIPPED"];

export interface FluidOrderPayload {
  id: number | string;
  order_number?: string;
  created_at?: string;
  email?: string;
  phone?: string;
  amount?: number | string;
  tax?: number | string;
  notes?: string;
  status?: string;
  ship_to?: Record<string, unknown>;
  items?: FluidLineItem[];
  metadata?: { shipping?: { title?: string } };
}

export interface FluidLineItem {
  id?: number | string;
  sku?: string;
  title?: string;
  quantity?: number;
  price?: number | string;
  tax?: number | string;
  weight?: number | string;
  unit_of_weight?: string;
  product?: { id?: number | string; sku?: string; title?: string; image_url?: string };
  variant?: { display_name?: string; title?: string };
  ordered_variant?: Array<{ option_type?: string; value?: string }>;
}

export interface CreateOrderInput {
  order: FluidOrderPayload;
  company_id: number | string;
}

export interface CreateOrderResult {
  success: boolean;
  data: Record<string, unknown> | null;
  error: string | null;
}

const ok = (data: Record<string, unknown>): CreateOrderResult => ({
  success: true,
  data,
  error: null,
});

export async function createShipstationOrder(
  input: CreateOrderInput,
  { respectHold = true }: { respectHold?: boolean } = {},
): Promise<CreateOrderResult> {
  const order = input.order ?? ({} as FluidOrderPayload);
  const company = await prisma.company.findFirst({
    where: { fluidCompanyId: BigInt(input.company_id) },
  });
  if (!company) throw new Error(`Company not found: ${input.company_id}`);

  const setting = await findIntegrationSetting(company.id);
  if (!setting) {
    throw new Error(`Integration settings not found for company: ${company.id}`);
  }

  const status = String(order.status ?? "");
  const shippingTitle = order.metadata?.shipping?.title?.trim() || null;

  // Record the shipping method at intake (before any hold) so the admin can map
  // methods on held/unpaid orders, not just shipped ones.
  if (shippingTitle) {
    await recordSeenShippingMethod({
      companyId: company.id,
      title: shippingTitle,
      orderNumber: order.order_number ?? null,
    });
  }

  // Orders that are neither fulfillable nor awaiting payment (cancelled,
  // refunded, …) are not sent to ShipStation. If we were already tracking the
  // order (e.g. it was HELD and then cancelled in Fluid), mark it CANCELLED so
  // a later release doesn't ship it from a stale payload.
  if (isUnfulfillable(status)) {
    await handleUnfulfillableOrder(company.id, order, status);
    console.warn(
      `[CreateOrder] skipping ${order.order_number} with status ${JSON.stringify(status)}`,
    );
    return ok({ skipped: `status=${status}` });
  }

  const local = await findOrCreateLocalOrder(company.id, order);

  try {
    // Serialize all decisions/writes for this one order so concurrent
    // order.created / order.updated / release-job invocations can't double-send.
    return await withRowLock(local.id, async () => {
      const fresh = await prisma.shipstationOrder.findUniqueOrThrow({
        where: { id: local.id },
      });
      return decideAndProcess({
        company,
        setting,
        order,
        local: fresh,
        respectHold,
        shippingTitle,
      });
    });
  } catch (error) {
    await prisma.shipstationOrder.update({
      where: { id: local.id },
      data: {
        status: "FAILED",
        lastError: error instanceof Error ? error.message : String(error),
        lastErrorAt: new Date(),
        retryCount: { increment: 1 },
      },
    });
    throw error;
  }
}

type Company = NonNullable<Awaited<ReturnType<typeof prisma.company.findFirst>>>;
type Setting = NonNullable<Awaited<ReturnType<typeof findIntegrationSetting>>>;

interface Decision {
  company: Company;
  setting: Setting;
  order: FluidOrderPayload;
  local: ShipstationOrder;
  respectHold: boolean;
  shippingTitle: string | null;
}

async function decideAndProcess(context: Decision): Promise<CreateOrderResult> {
  const { local, order, setting, respectHold } = context;

  // An order already in ShipStation: never blindly resubmit, but do propagate a
  // genuine Fluid-side edit (address/items/shipping method) as long as the order
  // hasn't been labeled yet. See reconcileSubmitted.
  if (SUBMITTED_STATUSES.includes(local.status)) {
    return reconcileSubmitted(context);
  }

  // Hold unpaid orders instead of sending. An order.updated webhook releases
  // them (calls this again) once the status becomes fulfillable.
  if (String(order.status ?? "") === AWAITING_PAYMENT_STATUS) {
    await prisma.shipstationOrder.update({
      where: { id: local.id },
      data: { status: "AWAITING_PAYMENT", lastError: null, lastErrorAt: null },
    });
    console.log(`[CreateOrder] holding ${order.order_number} as AWAITING_PAYMENT`);
    return ok({ held: true });
  }

  // Batching: park the order as HELD instead of submitting.
  // The release job (or a manual force-send) flushes it later.
  if (respectHold && setting.holdForBatch) {
    await holdForBatch(context);
    return ok({ held_for_batch: true });
  }

  return submitToShipstation(context);
}

/**
 * An order already sent to ShipStation received another order.created/updated.
 *
 * Re-push it ONLY when the shipping-relevant content actually changed AND the
 * ShipStation order has not been labeled/shipped — never disturb a labeled
 * order. `createorder` upserts by orderKey, so a re-push updates the existing
 * ShipStation order in place.
 */
async function reconcileSubmitted(context: Decision): Promise<CreateOrderResult> {
  const { local, order, company } = context;

  if (local.status === "SHIPPED") return ok({ skipped: "already SHIPPED" });
  if (!local.shipstationOrderId) return ok({ skipped: "no shipstation id" });
  if (!orderContentChanged(order, local)) return ok({ skipped: "no change" });

  if (await isShipstationOrderShipped(company.id, local.shipstationOrderId)) {
    console.log(
      `[CreateOrder] ${order.order_number} changed but already labeled; not updating`,
    );
    return ok({ skipped: "labeled" });
  }

  console.log(`[CreateOrder] re-pushing updated ${order.order_number} to ShipStation`);
  return submitToShipstation(context);
}

/**
 * Did the shipping-relevant part of the order change vs what we last sent?
 *
 * Compares only ship-to, line items (id/qty/sku/price) and the shipping method
 * title — ignoring unrelated order.updated noise (notes, timestamps).
 */
function orderContentChanged(order: FluidOrderPayload, local: ShipstationOrder): boolean {
  const previous = (local.requestPayload ?? {}) as unknown as FluidOrderPayload;
  return (
    JSON.stringify(shippingSignature(order)) !==
    JSON.stringify(shippingSignature(previous))
  );
}

function shippingSignature(payload: FluidOrderPayload) {
  return {
    ship_to: payload.ship_to ?? null,
    items: (payload.items ?? []).map((item) => ({
      id: item.id ?? null,
      quantity: item.quantity ?? null,
      sku: item.sku ?? null,
      price: item.price ?? null,
    })),
    title: payload.metadata?.shipping?.title ?? null,
  };
}

async function holdForBatch(context: Decision): Promise<void> {
  const { local, order, setting } = context;

  // Preserve an already-established batch deadline so repeated order.updated
  // events can't postpone the release indefinitely.
  const releaseAt =
    local.status === "HELD" && local.holdUntil
      ? local.holdUntil
      : batchReleaseAt(setting);

  await prisma.shipstationOrder.update({
    where: { id: local.id },
    data: {
      status: "HELD",
      holdUntil: releaseAt,
      lastError: null,
      lastErrorAt: null,
    },
  });
  console.log(
    `[CreateOrder] batch-holding ${order.order_number} (release: ${releaseAt?.toISOString() ?? "manual"})`,
  );
}

/**
 * When a batch window is configured, hold until now + window; otherwise hold
 * indefinitely (null) for manual release.
 */
function batchReleaseAt(setting: Setting): Date | null {
  const minutes = setting.batchWindowMinutes;
  if (!minutes || minutes <= 0) return null;
  return new Date(Date.now() + minutes * 60_000);
}

async function submitToShipstation(context: Decision): Promise<CreateOrderResult> {
  const { company, local, order, setting, shippingTitle } = context;

  const credentials = await credentialsFor(company.id);
  const payload = await buildShipstationPayload({
    company,
    setting,
    order,
    shippingTitle,
  });

  const response = await fetch(`${SHIPSTATION_API_BASE}/orders/createorder`, {
    method: "POST",
    headers: v1Headers(credentials),
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  const shipstationOrderId =
    body && typeof body === "object" && "orderId" in body
      ? (body as { orderId?: number | string }).orderId
      : undefined;

  if (shipstationOrderId === undefined || shipstationOrderId === null || shipstationOrderId === "") {
    return recordSubmitFailure(local, response.status, body);
  }

  // A concurrent shipment webhook may have already advanced this to SHIPPED;
  // don't regress a terminal status.
  if (local.status !== "SHIPPED") {
    await prisma.shipstationOrder.update({
      where: { id: local.id },
      data: {
        status: "SUBMITTED",
        shipstationOrderId: String(shipstationOrderId),
        responsePayload: (body ?? {}) as Prisma.InputJsonValue,
        // Record exactly what we sent so a later order.updated can tell whether
        // the order actually changed (see orderContentChanged).
        requestPayload: order as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Best-effort: the order is already in ShipStation, so a Fluid sync failure
  // must not throw (which would mark the order FAILED and re-submit it).
  try {
    await updateOrderExternalId(company.authenticationToken, {
      id: order.id,
      externalId: shipstationOrderId,
    });
  } catch (error) {
    console.error(
      `[CreateOrder] external id sync failed for ${order.order_number}:`,
      error instanceof Error ? error.message : error,
    );
  }

  return ok({ shipstation_order_id: shipstationOrderId });
}

/**
 * ShipStation rejected the order (or returned no orderId).
 *
 * Record the failure with the real reason so it surfaces in the Activity tab,
 * then decide whether to retry:
 *
 *   * 4xx (or a 2xx with no orderId) is a permanent data problem — a bad
 *     serviceCode, a missing field. Retrying can't fix it, so this returns a
 *     failure result WITHOUT throwing: throwing would burn the webhook retries
 *     for nothing.
 *   * 5xx is transient — throw, so the caller answers 500 and Fluid retries.
 */
async function recordSubmitFailure(
  local: ShipstationOrder,
  status: number,
  body: unknown,
): Promise<CreateOrderResult> {
  const detail = shipstationErrorDetail(status, body);

  await prisma.shipstationOrder.update({
    where: { id: local.id },
    data: {
      status: "FAILED",
      lastError: detail,
      lastErrorAt: new Date(),
      retryCount: { increment: 1 },
    },
  });
  console.error(`[CreateOrder] order ${local.fluidOrderNumber} rejected by ShipStation: ${detail}`);

  if (status >= 500) {
    throw new Error(
      `ShipStation error submitting ${local.fluidOrderNumber}: ${detail}`,
    );
  }

  return { success: false, data: null, error: detail };
}

/** e.g. "ShipStation 400: Invalid serviceCode". */
function shipstationErrorDetail(status: number, body: unknown): string {
  let message: string;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    message = String(
      record.Message ?? record.message ?? record.ExceptionMessage ?? JSON.stringify(body),
    );
  } else {
    message = String(body ?? "").trim() || "no response body";
  }

  return `ShipStation ${status}: ${message}`.slice(0, 1000);
}

/**
 * Fluid reports the order is no longer fulfillable (cancelled/refunded/…).
 * Cancel it wherever it lives:
 *
 *   * never sent to ShipStation   -> mark the local record CANCELLED
 *   * already SHIPPED / cancelled -> leave it (never recall a shipped order)
 *   * submitted to ShipStation    -> cancel it there too, UNLESS it already has
 *     a label; in that case leave it and record why.
 */
async function handleUnfulfillableOrder(
  companyId: bigint,
  order: FluidOrderPayload,
  status: string,
): Promise<void> {
  const local = await prisma.shipstationOrder.findFirst({
    where: { companyId, fluidOrderId: BigInt(order.id) },
  });
  if (!local) return;
  if (local.status === "CANCELLED" || local.status === "SHIPPED") return;

  if (!local.shipstationOrderId) {
    await prisma.shipstationOrder.update({
      where: { id: local.id },
      data: { status: "CANCELLED", lastError: `Fluid order status: ${status}` },
    });
    return;
  }

  const result = await cancelShipstationOrder(companyId, local.shipstationOrderId);

  if (result === "skipped_has_label") {
    await prisma.shipstationOrder.update({
      where: { id: local.id },
      data: {
        lastError: `Fluid order ${status}, but the ShipStation order already has a label — not cancelled`,
        lastErrorAt: new Date(),
      },
    });
    console.warn(
      `[CreateOrder] ${order.order_number} unfulfillable but already labeled in ShipStation`,
    );
    return;
  }

  await prisma.shipstationOrder.update({
    where: { id: local.id },
    data: { status: "CANCELLED", lastError: `Fluid order status: ${status}` },
  });
  console.log(
    `[CreateOrder] cancelled ${order.order_number} in ShipStation (${status})`,
  );
}

function isUnfulfillable(status: string): boolean {
  return (
    status.length > 0 &&
    !FULFILLABLE_STATUSES.includes(status) &&
    status !== AWAITING_PAYMENT_STATUS
  );
}

async function findOrCreateLocalOrder(
  companyId: bigint,
  order: FluidOrderPayload,
): Promise<ShipstationOrder> {
  const fluidOrderId = BigInt(order.id);
  const existing = await prisma.shipstationOrder.findUnique({
    where: { companyId_fluidOrderId: { companyId, fluidOrderId } },
  });

  if (!existing) {
    return prisma.shipstationOrder.create({
      data: {
        companyId,
        fluidOrderId,
        fluidOrderNumber: String(order.order_number ?? ""),
        status: "PENDING",
        requestPayload: order as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // Refresh the stored payload on existing pre-submit records so a later
  // release/resend uses the latest order data and status (e.g. an order held
  // while awaiting_payment must ship from the updated awaiting_shipment
  // payload, not the stale one it was first stored with).
  if (SUBMITTED_STATUSES.includes(existing.status)) return existing;

  return prisma.shipstationOrder.update({
    where: { id: existing.id },
    data: {
      requestPayload: order as unknown as Prisma.InputJsonValue,
      fluidOrderNumber: String(order.order_number ?? ""),
    },
  });
}

/**
 * `ShipstationOrder#with_lock` in Prisma: an interactive transaction whose
 * first statement takes a row lock, so a second webhook for the same order
 * blocks here rather than racing to submit it twice.
 */
async function withRowLock<T>(id: bigint, work: () => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM shipstation_orders WHERE id = ${id} FOR UPDATE`;
    return work();
  });
}

// --- ShipStation payload ---------------------------------------------------

async function buildShipstationPayload({
  company,
  setting,
  order,
  shippingTitle,
}: {
  company: Company;
  setting: Setting;
  order: FluidOrderPayload;
  shippingTitle: string | null;
}): Promise<Record<string, unknown>> {
  const shipTo = {
    name: order.ship_to?.name ?? null,
    company: company.name,
    street1: order.ship_to?.address1 ?? null,
    street2: order.ship_to?.address2 ?? null,
    city: order.ship_to?.city ?? null,
    state: order.ship_to?.state ?? null,
    postalCode: order.ship_to?.postal_code ?? null,
    country: order.ship_to?.country_code ?? null,
    phone: order.phone ?? null,
    residential: true,
  };

  return {
    orderNumber: order.order_number,
    orderKey: order.id,
    orderDate: order.created_at,
    orderStatus: "awaiting_shipment",
    customerUsername: order.email,
    customerEmail: order.email,
    billTo: shipTo,
    shipTo,
    items: (order.items ?? []).map(shipstationItem),
    amountPaid: order.amount,
    taxAmount: order.tax,
    customerNotes: order.notes,
    internalNotes: order.notes,
    ...(await shippingServiceFields(company.id, shippingTitle)),
    ...storeFields(setting),
  };
}

/**
 * Assigns the order to the configured ShipStation store, if any. Blank = the
 * default store for the API key (unchanged behavior).
 */
function storeFields(setting: Setting): Record<string, unknown> {
  const storeId = setting.storeId?.trim();
  if (!storeId) return {};
  return { advancedOptions: { storeId: Number.parseInt(storeId, 10) } };
}

/**
 * Resolves the Fluid order's shipping method title to ShipStation service
 * fields. The title is always passed as requestedShippingService (ShipStation
 * automation rules can key off it); carrier/service/package codes are added only
 * when the admin has configured a mapping for the title.
 */
async function shippingServiceFields(
  companyId: bigint,
  title: string | null,
): Promise<Record<string, unknown>> {
  if (!title) return {};

  const fields: Record<string, unknown> = { requestedShippingService: title };

  const mapping = await prisma.shippingMethodMapping.findFirst({
    where: { companyId, fluidShippingTitle: title },
  });
  if (!mapping) {
    console.warn(`[CreateOrder] no shipping mapping for ${JSON.stringify(title)}`);
    return fields;
  }

  // ShipStation rejects carrierCode unless a valid serviceCode rides with it
  // ("Invalid serviceCode", HTTP 400), so send carrier+service only as a
  // complete pair. A carrier without a service falls back to
  // requestedShippingService alone — which ShipStation accepts (the order lands
  // with no pre-assigned carrier) rather than failing the whole push.
  if (mapping.carrierCode && mapping.serviceCode) {
    fields.carrierCode = mapping.carrierCode;
    fields.serviceCode = mapping.serviceCode;
    if (mapping.packageCode) fields.packageCode = mapping.packageCode;
  } else if (mapping.carrierCode) {
    console.warn(
      `[CreateOrder] mapping for ${JSON.stringify(title)} has carrier ` +
        `${JSON.stringify(mapping.carrierCode)} but no service_code; sending ` +
        "requestedShippingService only (ShipStation requires carrier + service together)",
    );
  }

  return fields;
}

function shipstationItem(item: FluidLineItem): Record<string, unknown> {
  const line: Record<string, unknown> = {
    lineItemKey: String(item.id ?? ""),
    sku: item.sku,
    name: itemName(item),
    imageUrl: item.product?.image_url,
    quantity: item.quantity,
    unitPrice: item.price,
    taxAmount: item.tax,
    productId: item.product?.id,
    fulfillmentSku: item.product?.sku,
    adjustment: false,
  };

  const options = itemOptions(item);
  if (options.length > 0) line.options = options;

  const weight = itemWeight(item);
  if (weight) line.weight = weight;

  return line;
}

/**
 * ShipStation prints line-item `options` (name/value pairs) on the packing slip,
 * so warehouse staff see which variant/size to pick. Built from the Fluid
 * variant: structured option values when present (e.g. Size => Large),
 * otherwise the variant's own title/name when it names a specific variant the
 * product title doesn't already convey.
 */
function itemOptions(item: FluidLineItem): Array<{ name: string; value: string }> {
  const structured = (item.ordered_variant ?? [])
    .filter((option) => !!option?.value)
    .map((option) => ({
      name: option.option_type || "Variant",
      value: String(option.value),
    }));
  if (structured.length > 0) return structured;

  const label = variantLabel(item);
  return label ? [{ name: "Variant", value: label }] : [];
}

/**
 * Belt-and-suspenders for packing-slip templates that don't render options:
 * fold the variant label into the item name when the name doesn't already
 * contain it.
 */
function itemName(item: FluidLineItem): string {
  const base = String(item.title ?? "");
  const label = variantLabel(item);
  if (!label || base.toLowerCase().includes(label.toLowerCase())) return base;
  return `${base} — ${label}`;
}

/**
 * Fluid auto-creates a single "Default Variant" for products with no real
 * options; it names no size and would just add noise on the packing slip.
 */
const IGNORED_VARIANT_LABELS = ["default variant"];

/**
 * A single human label for the ordered variant, or null when the variant adds
 * nothing beyond the product name (e.g. single-variant products whose size is
 * already in the title).
 */
function variantLabel(item: FluidLineItem): string | null {
  const fromStructured = (item.ordered_variant ?? [])
    .map((option) => option?.value)
    .filter((value): value is string => !!value)
    .join(", ");
  if (fromStructured) return fromStructured;

  const candidate = item.variant?.display_name || item.variant?.title || "";
  const productName = item.product?.title || item.title;
  if (!candidate || IGNORED_VARIANT_LABELS.includes(candidate.toLowerCase())) {
    return null;
  }
  if (candidate !== productName && candidate !== item.title) return candidate;

  return null;
}

/**
 * ShipStation weight object {value, units}. Fluid weights use kg/gm/lb/oz
 * (default gm); ShipStation accepts only grams/ounces/pounds, so kg is converted
 * to grams. Returns null when Fluid has no positive weight, so an unweighted
 * product omits the field rather than sending 0.
 */
const FLUID_WEIGHT_UNITS: Record<string, string> = {
  gm: "grams", g: "grams", gram: "grams", grams: "grams",
  lb: "pounds", lbs: "pounds", pound: "pounds", pounds: "pounds",
  oz: "ounces", ounce: "ounces", ounces: "ounces",
};

function itemWeight(item: FluidLineItem): { value: number; units: string } | null {
  const value = Number(item.weight ?? 0);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = String(item.unit_of_weight ?? "").toLowerCase();
  if (unit === "kg") {
    return { value: Math.round(value * 1000 * 1e4) / 1e4, units: "grams" };
  }

  return { value, units: FLUID_WEIGHT_UNITS[unit] ?? "grams" };
}

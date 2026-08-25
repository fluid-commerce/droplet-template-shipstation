/**
 * Fluid API calls made with a COMPANY's token.
 *
 * Port of app/services/fluid_api/*. This is a different client from
 * src/lib/fluid, which speaks the droplet/webhook/callback admin endpoints with
 * the droplet's own key; these are the commerce endpoints a company's install
 * token can reach.
 *
 * Every endpoint here is one the Rails app already calls in production.
 */

const FLUID_API_BASE_URL = process.env.FLUID_API_URL
  ? `${process.env.FLUID_API_URL.replace(/\/$/, "")}/api`
  : "https://api.fluid.app/api";

function headers(companyToken: string): HeadersInit {
  return {
    Authorization: `Bearer ${companyToken}`,
    "Content-Type": "application/json",
    "x-fluid-client": "shipstation-droplet",
  };
}

export interface FluidOrderItem {
  id: number | string;
  quantity: number;
}

export interface FluidOrder {
  order?: { id?: number | string; items?: FluidOrderItem[] };
  error?: unknown;
}

/** GET /api/v202506/orders/:id */
export async function retrieveOrder(
  companyToken: string,
  id: number | string,
): Promise<FluidOrder | null> {
  const response = await fetch(`${FLUID_API_BASE_URL}/v202506/orders/${id}`, {
    headers: headers(companyToken),
  });

  const text = await response.text();
  if (!text) return null;

  const parsed = JSON.parse(text) as FluidOrder;
  return parsed?.error ? null : parsed;
}

export interface TrackingInformation {
  tracking_number: string;
  /** Fluid uses this to build a tracking URL. Omitted when the carrier is unknown. */
  shipping_carrier?: string;
}

/**
 * POST /api/order_fulfillments.
 *
 * One `tracking_informations` entry per package, so Fluid records every
 * tracking number rather than only the first.
 */
export async function createOrderFulfillment(
  companyToken: string,
  {
    id,
    orderItems,
    trackingInformations,
  }: {
    id: number | string;
    orderItems: FluidOrderItem[];
    trackingInformations: TrackingInformation[];
  },
): Promise<unknown> {
  const response = await fetch(`${FLUID_API_BASE_URL}/order_fulfillments`, {
    method: "POST",
    headers: headers(companyToken),
    body: JSON.stringify({
      order_id: id,
      order_items: orderItems.map((item) => ({
        item_id: item.id,
        quantity: item.quantity,
      })),
      tracking_informations: trackingInformations,
    }),
  });

  const text = await response.text();
  const parsed: unknown = text ? JSON.parse(text) : null;

  if (!parsed || (typeof parsed === "object" && "error" in parsed)) {
    throw new Error(
      `Failed to fulfill order ${id} in Fluid: ${JSON.stringify(parsed)}`,
    );
  }

  return parsed;
}

/** PATCH /api/v2/orders/:id/update_external_id */
export async function updateOrderExternalId(
  companyToken: string,
  { id, externalId }: { id: number | string; externalId: number | string },
): Promise<void> {
  const response = await fetch(
    `${FLUID_API_BASE_URL}/v2/orders/${id}/update_external_id`,
    {
      method: "PATCH",
      headers: headers(companyToken),
      body: JSON.stringify({ order: { external_id: String(externalId) } }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Fluid update_external_id failed for order ${id}: ${response.status}`,
    );
  }
}

/**
 * GET /api/v2/integrations/shipping_methods.
 *
 * The distinct shipping method names a company has configured — these match the
 * `order.metadata.shipping.title` seen on Fluid-calculated shipping. Uses the
 * droplet install token (orders.view scope). Best-effort: [] on any failure, so
 * the UI falls back to the auto-tracked "seen" titles and manual entry.
 */
export async function listShippingMethodNames(
  companyToken: string,
): Promise<string[]> {
  try {
    const response = await fetch(
      `${FLUID_API_BASE_URL}/v2/integrations/shipping_methods?per_page=200`,
      { headers: headers(companyToken) },
    );
    if (!response.ok) return [];

    const body: unknown = await response.json();
    return extractMethods(body)
      .map((method) => String(method?.name ?? ""))
      .filter((name) => name.length > 0)
      .filter((name, index, all) => all.indexOf(name) === index);
  } catch (error) {
    console.error(
      "[FluidApi::ShippingMethods]",
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

/**
 * The endpoint may wrap the collection under a key or return a bare array;
 * handle the common envelopes without assuming one.
 */
function extractMethods(body: unknown): Array<{ name?: unknown }> {
  if (Array.isArray(body)) return body as Array<{ name?: unknown }>;
  if (!body || typeof body !== "object") return [];

  const record = body as Record<string, unknown>;
  const candidate = record.shipping_methods ?? record.data;
  return Array.isArray(candidate) ? (candidate as Array<{ name?: unknown }>) : [];
}

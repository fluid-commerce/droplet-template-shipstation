/**
 * Port of ShippingCatalogController#carriers.
 *
 * These endpoints are a backend proxy for the Shipping Methods tab's dropdowns.
 * They exist so the ShipStation credentials and the Fluid token stay
 * server-side: the browser gets codes and names, never a key.
 */

import { NextResponse } from "next/server";

import { withDri } from "@/lib/dri";
import { listCarriers } from "@/lib/shipstation/carriers";

export const GET = withDri(async (company) => {
  const carriers = await listCarriers(company.id);

  return NextResponse.json({
    carriers: carriers.map((carrier) => ({
      code: carrier.code,
      name: carrier.name || carrier.nickname || carrier.code,
    })),
  });
});

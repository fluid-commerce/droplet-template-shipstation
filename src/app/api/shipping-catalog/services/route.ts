/** Port of ShippingCatalogController#services. */

import { NextResponse } from "next/server";

import { withDri } from "@/lib/dri";
import { listServices } from "@/lib/shipstation/carriers";

export const GET = withDri(async (company, _body, request) => {
  const carrierCode = new URL(request.url).searchParams.get("carrier_code") ?? "";
  const services = await listServices(company.id, carrierCode);

  return NextResponse.json({
    services: services.map((service) => ({
      code: service.code,
      name: service.name || service.code,
    })),
  });
});

/** Port of ShippingCatalogController#packages. */

import { NextResponse } from "next/server";

import { withDri } from "@/lib/dri";
import { listPackages } from "@/lib/shipstation/carriers";

export const GET = withDri(async (company, _body, request) => {
  const carrierCode = new URL(request.url).searchParams.get("carrier_code") ?? "";
  const packages = await listPackages(company.id, carrierCode);

  return NextResponse.json({
    packages: packages.map((pkg) => ({
      code: pkg.code,
      name: pkg.name || pkg.code,
    })),
  });
});

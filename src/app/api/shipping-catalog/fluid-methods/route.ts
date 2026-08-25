/**
 * Port of ShippingCatalogController#fluid_methods.
 *
 * Fluid shipping method titles: the methods configured in Fluid merged with the
 * titles actually seen on orders — which cover shipping strategies the API
 * omits, and are the ones that matter for mapping.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { withDri } from "@/lib/dri";
import { listShippingMethodNames } from "@/lib/fluid-api";

export const GET = withDri(async (company) => {
  const fromApi = await listShippingMethodNames(company.authenticationToken);
  const seen = await prisma.seenShippingMethod.findMany({
    where: { companyId: company.id },
    select: { fluidShippingTitle: true },
  });

  const titles = [...fromApi, ...seen.map((row) => row.fluidShippingTitle)]
    .map((title) => String(title))
    .filter((title) => title.length > 0);

  return NextResponse.json({ titles: [...new Set(titles)].sort() });
});

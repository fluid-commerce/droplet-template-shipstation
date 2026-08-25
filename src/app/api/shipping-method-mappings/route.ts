/**
 * Port of ShippingMethodMappingsController#index and #create.
 *
 * The index returns the configured mappings PLUS the titles seen on real orders
 * that are not mapped yet, so the UI can prompt an admin to map a method it has
 * actually observed rather than one they had to guess at.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { withDri, type DriCompany } from "@/lib/dri";

interface Body {
  shipping_method_mapping?: {
    fluid_shipping_title?: string;
    carrier_code?: string;
    service_code?: string;
    package_code?: string;
    description?: string;
  };
}

export const GET = withDri(async (company) => {
  const mappings = await prisma.shippingMethodMapping.findMany({
    where: { companyId: company.id },
    orderBy: { fluidShippingTitle: "asc" },
  });
  const seen = await prisma.seenShippingMethod.findMany({
    where: { companyId: company.id },
    orderBy: { seenCount: "desc" },
  });

  const mapped = new Set(
    mappings.map((mapping) => mapping.fluidShippingTitle.toLowerCase()),
  );

  return NextResponse.json({
    mappings: mappings.map(mappingJson),
    unmapped: seen
      .filter((row) => !mapped.has(row.fluidShippingTitle.toLowerCase()))
      .map((row) => ({
        fluid_shipping_title: row.fluidShippingTitle,
        seen_count: row.seenCount,
        last_seen_at: row.lastSeenAt,
        example_order_number: row.exampleOrderNumber,
      })),
  });
});

/** Upserts a mapping keyed by fluid_shipping_title (case-insensitive per company). */
export const POST = withDri<Body>(async (company: DriCompany, body) => {
  const params = body.shipping_method_mapping ?? {};
  const title = (params.fluid_shipping_title ?? "").trim();

  if (!title) {
    return NextResponse.json(
      { errors: ["Shipping method title is required"] },
      { status: 422 },
    );
  }

  // ShipStation requires a carrier and service together — a carrier alone is
  // rejected at order-push time ("Invalid serviceCode", HTTP 400). Enforce the
  // pairing here so an incomplete mapping can't be saved in the first place.
  const carrierCode = params.carrier_code?.trim() || null;
  const serviceCode = params.service_code?.trim() || null;
  if (carrierCode && !serviceCode) {
    return NextResponse.json(
      { errors: ["Service code can't be blank"] },
      { status: 422 },
    );
  }

  const attributes = {
    carrierCode,
    serviceCode,
    packageCode: params.package_code?.trim() || null,
    description: params.description?.trim() || null,
  };

  const existing = await prisma.shippingMethodMapping.findFirst({
    where: {
      companyId: company.id,
      fluidShippingTitle: { equals: title, mode: "insensitive" },
    },
  });

  const mapping = existing
    ? await prisma.shippingMethodMapping.update({
        where: { id: existing.id },
        data: attributes,
      })
    : await prisma.shippingMethodMapping.create({
        data: { companyId: company.id, fluidShippingTitle: title, ...attributes },
      });

  return NextResponse.json(mappingJson(mapping), { status: 201 });
});

function mappingJson(mapping: {
  id: bigint;
  fluidShippingTitle: string;
  carrierCode: string | null;
  serviceCode: string | null;
  packageCode: string | null;
  description: string | null;
}) {
  return {
    id: Number(mapping.id),
    fluid_shipping_title: mapping.fluidShippingTitle,
    carrier_code: mapping.carrierCode,
    service_code: mapping.serviceCode,
    package_code: mapping.packageCode,
    description: mapping.description,
  };
}

/**
 * Port of ShippingMethodMappingsController#destroy.
 *
 * Scoped to the DRI's company, so an id belonging to another installation is a
 * 404 rather than a delete.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { requireDriCompany, DriAuthError } from "@/lib/dri";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const company = await requireDriCompany(request);
    const { id } = await params;

    const mapping = await prisma.shippingMethodMapping.findFirst({
      where: { id: BigInt(id), companyId: company.id },
    });
    if (!mapping) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.shippingMethodMapping.delete({ where: { id: mapping.id } });
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof DriAuthError) return error.response;
    console.error(
      "[ShippingMethodMappings] delete failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

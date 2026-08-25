/**
 * Port of app/models/seen_shipping_method.rb (`SeenShippingMethod.record!`).
 *
 * Records every distinct shipping method title observed on incoming Fluid
 * orders so the admin can see which titles still need a mapping. Tracking is
 * best-effort and must never block order processing — including the unique-index
 * race two concurrent orders for the same title will lose.
 */

import { prisma } from "@/lib/db";

export async function recordSeenShippingMethod({
  companyId,
  title,
  orderNumber,
}: {
  companyId: bigint;
  title: string;
  orderNumber?: string | null;
}): Promise<void> {
  if (!title) return;

  try {
    const existing = await prisma.seenShippingMethod.findFirst({
      where: { companyId, fluidShippingTitle: title },
    });

    if (existing) {
      await prisma.seenShippingMethod.update({
        where: { id: existing.id },
        data: {
          seenCount: { increment: 1 },
          lastSeenAt: new Date(),
          exampleOrderNumber: existing.exampleOrderNumber ?? orderNumber ?? null,
        },
      });
      return;
    }

    await prisma.seenShippingMethod.create({
      data: {
        companyId,
        fluidShippingTitle: title,
        seenCount: 1,
        lastSeenAt: new Date(),
        exampleOrderNumber: orderNumber ?? null,
      },
    });
  } catch (error) {
    console.warn(
      `[SeenShippingMethod] failed to record ${JSON.stringify(title)}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

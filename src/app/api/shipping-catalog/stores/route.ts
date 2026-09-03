/**
 * Port of ShippingCatalogController#stores.
 *
 * The ShipStation stores an order can be assigned to (advancedOptions.storeId).
 */

import { NextResponse } from "next/server";

import { withDri } from "@/lib/dri";
import { listStores } from "@/lib/shipstation/carriers";

export const GET = withDri(async (company) => {
  const stores = await listStores(company.id);

  return NextResponse.json({
    stores: stores.map((store) => ({
      id: String(store.storeId ?? ""),
      name: store.storeName || `Store ${store.storeId}`,
      marketplace: store.marketplaceName ?? null,
    })),
  });
});

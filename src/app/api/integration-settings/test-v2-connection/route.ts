/** Port of IntegrationSettingsController#test_v2_connection. */

import { NextResponse } from "next/server";

import { withDri } from "@/lib/dri";
import { testV2Connection } from "@/lib/shipstation/test-connection";

export const POST = withDri(async (company) =>
  NextResponse.json(await testV2Connection(company.id)),
);

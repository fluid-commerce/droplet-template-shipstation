/** Port of IntegrationSettingsController#test_connection. */

import { NextResponse } from "next/server";

import { withDri } from "@/lib/dri";
import { testV1Connection } from "@/lib/shipstation/test-connection";

export const POST = withDri(async (company) =>
  NextResponse.json({ connection: await testV1Connection(company.id) }),
);

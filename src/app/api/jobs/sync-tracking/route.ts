/**
 * Scheduled equivalent of SyncTrackingJob (config/recurring.yml: every 30
 * minutes). Point Cloud Scheduler at it with the `CRON_SECRET` bearer token.
 */

import { NextResponse } from "next/server";

import { isAuthorizedJobRequest } from "@/lib/jobs/authorize";
import { syncTracking } from "@/lib/jobs/sync-tracking";

export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await syncTracking());
  } catch (error) {
    console.error(
      "[SyncTracking] run failed:",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

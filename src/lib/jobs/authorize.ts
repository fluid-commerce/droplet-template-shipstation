/**
 * Shared-secret guard for the scheduled-job routes.
 *
 * Rails ran SyncTrackingJob and ReleaseHeldOrdersJob from Solid Queue's
 * recurring tasks, inside the app. A standalone Next droplet on Cloud Run has no
 * always-on worker, so they are HTTP endpoints driven by Cloud Scheduler
 * instead — which means they need an authenticator Solid Queue never did.
 *
 * `CRON_SECRET` is unset by default and an unset secret REFUSES every request
 * rather than allowing them: an unauthenticated endpoint that force-sends orders
 * to a carrier is not an acceptable default.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export function isAuthorizedJobRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[Jobs] CRON_SECRET is not set — refusing the request");
    return false;
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented) return false;

  return timingSafeEqual(
    createHash("sha256").update(presented).digest(),
    createHash("sha256").update(secret).digest(),
  );
}

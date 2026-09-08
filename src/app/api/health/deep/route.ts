/**
 * Deep health check — "can this service actually do its job", not "is it up".
 *
 * `/api/health` answers 200 as soon as the process is listening. That is what
 * every pre-cutover check relied on, and it is why nuvamed's cutover on
 * 2026-09-08 passed every gate and then failed on its first real order: the
 * Prisma schema declared an `integration_settings.credentials` column that does
 * not exist in the database, so every `order.created` 500'd. Nothing before
 * this endpoint touched that table (STU2-3293).
 *
 * Two things are checked here, because they are the two that a deploy can get
 * wrong while looking perfectly healthy from outside:
 *
 *  1. The `integration_settings` query the order path runs. A schema that
 *     describes a different table than the one that exists fails here.
 *  2. Whether the stored settings can be DECRYPTED. The Active Record
 *     encryption keys are supplied as three separate secrets; wire any of them
 *     wrongly and the service still starts, still verifies webhook signatures,
 *     and still cannot read a single company's ShipStation credentials.
 *
 * Only counts and booleans are returned — never a decrypted value, never a
 * company's credentials, and never which key failed.
 *
 * Authenticated with CRON_SECRET, the same bearer the job routes use. This is a
 * diagnostic, not a public endpoint: an unauthenticated caller learns nothing.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { isAuthorizedJobRequest } from "@/lib/jobs/authorize";
import { secretsOf } from "@/lib/integration-settings";

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const result = {
    ok: false,
    database: false,
    integrationSettings: { queried: 0, decryptable: 0, undecryptable: 0 },
    error: null as string | null,
  };

  try {
    const companies = await prisma.company.findMany({
      where: { active: true },
      select: { id: true },
    });
    result.database = true;

    for (const company of companies) {
      // The exact query the order path runs. A schema/table mismatch throws
      // here, which is the whole point.
      const setting = await prisma.integrationSetting.findUnique({
        where: { companyId: company.id },
      });
      if (!setting) continue;

      result.integrationSettings.queried += 1;
      try {
        const secrets = secretsOf(setting);
        // Decrypting to an empty object is not proof of anything — a company
        // may simply not have configured ShipStation yet — so only a settings
        // blob that yields at least one key counts as decryptable.
        if (Object.keys(secrets).length > 0) {
          result.integrationSettings.decryptable += 1;
        }
      } catch {
        result.integrationSettings.undecryptable += 1;
      }
    }

    // Healthy means: the query works, and every configured row that exists
    // could be read. A service with no configured companies is NOT declared
    // healthy — there would be nothing to prove.
    result.ok =
      result.integrationSettings.queried > 0 &&
      result.integrationSettings.undecryptable === 0 &&
      result.integrationSettings.decryptable > 0;
  } catch (error) {
    // The message, never the payload: a Prisma error quotes the failing query.
    result.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}

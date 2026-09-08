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
 * Three things are checked, because they are the three a deploy can get wrong
 * while looking perfectly healthy from outside:
 *
 *  1. The `integration_settings` query the order path runs. A schema that
 *     describes a different table than the one that exists fails here.
 *  2. Whether the stored settings can be DECRYPTED. The Active Record
 *     encryption keys are supplied as three separate secrets; wire any of them
 *     wrongly and the service still starts, still verifies webhook signatures,
 *     and still cannot read a single company's ShipStation credentials.
 *  3. Whether what decrypts is USABLE by the order path. A blob holding only
 *     `api_key` decrypts fine and then sends `Basic key:` to ShipStation,
 *     which 401s every order.
 *
 * ## Ask about a company, not about "some company"
 *
 * `?company=<fluid_shop | fluid_company_id | id>` scopes all of the above to
 * ONE company and is what a cutover must use. Without it the answer aggregates,
 * and an aggregate cannot gate a per-company move: nuvamed could hold no
 * settings row at all while another tenant's row decrypts cleanly, and this
 * endpoint would answer 200 while `createShipstationOrder` threw
 * "Integration settings not found" for every nuvamed order. `scripts/cutover.ts`
 * repoints one company at a time (`loadCompany`), so it always passes the
 * company it is about to move.
 *
 * Only counts and booleans are returned — never a decrypted value, never a
 * company's credentials, and never which key failed.
 *
 * Authenticated with CRON_SECRET, the same bearer the job routes use. This is a
 * diagnostic, not a public endpoint: an unauthenticated caller learns nothing.
 */

import { NextResponse } from "next/server";

import type { IntegrationSetting } from "@prisma/client";

import { prisma } from "@/lib/db";
import { isAuthorizedJobRequest } from "@/lib/jobs/authorize";
import {
  findIntegrationSetting,
  secretsOf,
  type ShipstationSecrets,
} from "@/lib/integration-settings";

/**
 * Whether these secrets would actually submit an order.
 *
 * The v1 PAIR, always — deliberately not keyed off the company's `api_version`.
 * `createShipstationOrder` POSTs to `${SHIPSTATION_API_BASE}/orders/createorder`
 * with `v1Headers(credentials)` unconditionally; nothing on the order path
 * consults `api_version` or `isV2`, which today only reach the settings screen
 * and `testConnection`. So a company set to v2 and holding only a `v2_api_key`
 * would have every order sent as `Basic :` — a syntactically valid header
 * ShipStation rejects — and calling that healthy here would wave through the
 * cutover of a company whose orders cannot land.
 *
 * If v2 order submission is ever implemented, this is one of the places that
 * has to change with it.
 *
 * Mirrors `hasV1Credentials` in src/lib/shipstation/client.ts, as a value check
 * rather than an import: that helper takes the camelCase credentials shape, and
 * pulling it in would drag the ShipStation client into a health route.
 */
function credentialsUsable(secrets: ShipstationSecrets): boolean {
  return !!secrets.api_key && !!secrets.api_secret;
}

export async function GET(request: Request): Promise<Response> {
  if (!isAuthorizedJobRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const handle = new URL(request.url).searchParams.get("company")?.trim() || null;

  const result = {
    ok: false,
    database: false,
    /** Echoed back so a caller cannot mistake an aggregate answer for a scoped one. */
    company: handle,
    scoped: handle !== null,
    integrationSettings: {
      queried: 0,
      decryptable: 0,
      undecryptable: 0,
      /** Decrypted, but missing a credential the order path needs. */
      unusable: 0,
    },
    error: null as string | null,
  };

  try {
    let rows: IntegrationSetting[];

    if (handle) {
      // One company. A handle that matches nothing, or matches a company with
      // no settings row, is a FAILED check — not an empty aggregate. Asking
      // about nuvamed and being told about someone else is the whole bug this
      // parameter exists to prevent.
      const company = await prisma.company.findFirst({
        where: {
          OR: [
            { fluidShop: handle },
            { fluidCompanyId: /^\d+$/.test(handle) ? BigInt(handle) : BigInt(-1) },
            { id: /^\d+$/.test(handle) ? BigInt(handle) : BigInt(-1) },
          ],
        },
      });
      result.database = true;

      if (!company) {
        result.error = `no company matches "${handle}"`;
        return NextResponse.json(result, { status: 503 });
      }
      if (!company.active) {
        result.error = `company "${handle}" is not active`;
        return NextResponse.json(result, { status: 503 });
      }

      // Count the rows the order path could resolve to, do not just look one up.
      //
      // A webhook does not carry our primary key; `createShipstationOrder` does
      // `company.findFirst({ where: { fluidCompanyId } })`, `fluid_company_id`
      // carries an index but NOT a unique constraint, and that findFirst has no
      // ordering. Two rows sharing a fluid_company_id would let a real order be
      // served from the row we did not check — reading another company's
      // ShipStation credentials, or none.
      //
      // Repeating the findFirst here would NOT establish that. Both calls are
      // unordered, so both would very likely return the same row, and the check
      // would report healthy right up until a plan change or a physical row
      // reorder made the order path pick the other one. The only assertion
      // worth making is that exactly one row exists. There are no duplicate
      // groups in production today (measured 2026-09-08), which is why this is
      // worth holding: cheap to keep true, expensive to discover has stopped
      // being true.
      const sharingFluidCompanyId = await prisma.company.count({
        where: { fluidCompanyId: company.fluidCompanyId },
      });
      if (sharingFluidCompanyId !== 1) {
        result.error =
          `${sharingFluidCompanyId} companies share fluid_company_id ` +
          `${company.fluidCompanyId}, which the order path resolves by with an ` +
          `unordered findFirst, so orders could be served from another ` +
          `company's settings`;
        return NextResponse.json(result, { status: 503 });
      }

      // findIntegrationSetting, NOT a hand-written query with a `select`.
      //
      // This must be the order path's own call, unqualified. Prisma only asks
      // for the columns a `select` names, so narrowing it to the two fields
      // this route reads would silence exactly the class of failure the route
      // exists to catch: a schema declaring `credentials` (or any other absent
      // column) throws on the order path's unqualified findUnique and would
      // NOT throw on a narrowed one. That is the nuvamed outage reproduced
      // inside its own health check.
      const setting = await findIntegrationSetting(company.id);
      if (!setting) {
        result.error = `company "${handle}" has no integration_settings row`;
        return NextResponse.json(result, { status: 503 });
      }
      rows = [setting];
    } else {
      // Unqualified for the same reason the settings lookup is: the order path
      // reads companies with a bare `findFirst`, so a narrowed select here would
      // pass over a drifted `companies` table that the order path trips on.
      const companies = await prisma.company.findMany({ where: { active: true } });
      result.database = true;

      rows = [];
      for (const company of companies) {
        // Unqualified, for the reason given in the scoped branch above.
        const setting = await findIntegrationSetting(company.id);
        if (setting) rows.push(setting);
      }
    }

    for (const setting of rows) {
      result.integrationSettings.queried += 1;
      let secrets: ShipstationSecrets;
      try {
        secrets = secretsOf(setting);
      } catch {
        result.integrationSettings.undecryptable += 1;
        continue;
      }
      // Decrypting to an empty object is not proof of anything — a company may
      // simply not have configured ShipStation yet — and neither is decrypting
      // to a PARTIAL one, which authenticates against nothing.
      if (credentialsUsable(secrets)) {
        result.integrationSettings.decryptable += 1;
      } else {
        result.integrationSettings.unusable += 1;
      }
    }

    // Healthy means: the query works, and every row we looked at could be read
    // AND used. A service with no configured companies is NOT declared healthy
    // — there would be nothing to prove.
    result.ok =
      result.integrationSettings.queried > 0 &&
      result.integrationSettings.undecryptable === 0 &&
      result.integrationSettings.unusable === 0 &&
      result.integrationSettings.decryptable > 0;
  } catch (error) {
    // The message, never the payload: a Prisma error quotes the failing query.
    result.error = error instanceof Error ? error.message.split("\n")[0] : String(error);
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}

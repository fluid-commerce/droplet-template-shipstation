/**
 * Port of WebhookController#shipped (`POST /webhook/shipped` in Rails).
 *
 * A "this batch shipped" notification carrying a ShipStation `resource_url`.
 * It is NOT a Fluid webhook — nothing HMAC-signs it — so it cannot go through
 * `withFluidWebhook`, and it keeps the Rails shared-token scheme:
 *
 *     AUTH_TOKEN / X-Auth-Token  ==  this droplet's FLUID_WEBHOOK_AUTH_TOKEN
 *                                or  the named company's webhook_verification_token
 *
 * Two things are tightened relative to the Ruby, without changing who gets in:
 *
 *  - The comparison is `timingSafeEqual` over equal-length digests, so a token
 *    cannot be recovered a byte at a time. Rails used
 *    ActiveSupport::SecurityUtils.secure_compare, which is the same idea; a
 *    plain `===` here would not have been.
 *  - `Company.find(company_id)` is gone. Rails fell back to the PRIMARY KEY when
 *    `fluid_company_id` missed, so a caller passing `1` addressed whichever
 *    company happened to be row 1. Only fluid_company_id is accepted now.
 *
 * The SSRF guard on resource_url stays, and is enforced again in
 * syncShippedOrder — this endpoint decides where the company's ShipStation
 * credentials get sent.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { isAllowedShipstationUrl } from "@/lib/shipstation/client";
import { syncShippedOrder } from "@/lib/shipstation/sync-shipped-order";

interface ShippedBody {
  resource_url?: string;
  company_id?: string | number;
}

export async function POST(request: Request): Promise<Response> {
  let body: ShippedBody;
  try {
    body = (await request.json()) as ShippedBody;
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const { resource_url: resourceUrl, company_id: companyId } = body;

  if (!resourceUrl || companyId === undefined || companyId === null) {
    console.warn("[ShipStation Webhook] Missing resource_url or company_id");
    return NextResponse.json(
      { error: "resource_url and company_id are required" },
      { status: 400 },
    );
  }

  // Validate resource_url points at ShipStation before anything else, so a
  // forged host is rejected without a database lookup.
  if (!isAllowedShipstationUrl(resourceUrl)) {
    console.warn("[ShipStation Webhook] Invalid resource_url");
    return NextResponse.json({ error: "invalid resource_url" }, { status: 400 });
  }

  // BigInt() throws a SyntaxError on anything non-numeric, and this is reached
  // before authentication — an unsigned "company_id": "abc" would otherwise be
  // an unhandled 500 rather than a rejected request.
  let fluidCompanyId: bigint;
  try {
    fluidCompanyId = BigInt(companyId);
  } catch {
    return NextResponse.json({ error: "invalid company_id" }, { status: 400 });
  }

  const company = await prisma.company.findFirst({
    where: { fluidCompanyId },
  });

  if (!authorized(request, company?.webhookVerificationToken ?? null)) {
    console.warn("[ShipStation Webhook] rejected: bad auth token");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!company) {
    return NextResponse.json({ error: "Company not found" }, { status: 404 });
  }

  try {
    await syncShippedOrder(resourceUrl, company.id);
  } catch (error) {
    console.error(
      "[ShipStation Webhook] shipped sync failed:",
      error instanceof Error ? error.message : error,
    );
    // A 5xx is a retry signal, which is what a transient ShipStation or Fluid
    // failure deserves.
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }

  return new NextResponse(null, { status: 202 });
}

function authorized(request: Request, companyToken: string | null): boolean {
  const presented =
    request.headers.get("auth-token") ?? request.headers.get("x-auth-token");
  if (!presented) return false;

  const candidates = [companyToken, process.env.FLUID_WEBHOOK_AUTH_TOKEN].filter(
    (token): token is string => !!token,
  );

  // Digest first so timingSafeEqual always compares equal-length buffers —
  // it throws otherwise, and the throw itself would leak the length.
  const presentedDigest = createHash("sha256").update(presented).digest();

  return candidates.some((token) =>
    timingSafeEqual(presentedDigest, createHash("sha256").update(token).digest()),
  );
}

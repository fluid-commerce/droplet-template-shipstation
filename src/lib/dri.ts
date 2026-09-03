/**
 * DRI authentication for the embedded droplet UI and the endpoints it calls.
 *
 * Port of app/controllers/concerns/dri_authenticatable.rb.
 *
 * When Fluid embeds this droplet in an iframe it passes the installation's
 * unguessable `droplet_installation_uuid` (the DRI) as `?dri=…`. The DRI
 * identifies a single installation, so resolving the company FROM it — rather
 * than trusting a client-supplied company id — is what authenticates and scopes
 * the request.
 *
 * Two differences from the Ruby:
 *
 *  - Rails cached the DRI in the session so follow-up requests didn't have to
 *    resend it. That is dropped: an ambient session cookie is what turns these
 *    endpoints into CSRF targets in the first place, and the embedded UI already
 *    sends the DRI on every call. Nothing is stored server-side.
 *  - The `X-Requested-With` check is kept, and for the same reason: browsers only
 *    allow that header on same-origin scripted requests, so a cross-site form
 *    post cannot forge it.
 */

import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

export type DriCompany = NonNullable<
  Awaited<ReturnType<typeof prisma.company.findFirst>>
>;

export class DriAuthError extends Error {
  constructor(
    message: string,
    readonly response: NextResponse,
  ) {
    super(message);
    this.name = "DriAuthError";
  }
}

const unauthorized = (error: string) =>
  new DriAuthError(error, NextResponse.json({ error }, { status: 401 }));

/**
 * Resolves the company for a request, or throws a DriAuthError carrying the
 * response to return. Reads the DRI from the query string and, for mutations
 * where a query param is awkward, from the parsed JSON body.
 */
export async function requireDriCompany(
  request: Request,
  body?: unknown,
): Promise<DriCompany> {
  if (request.headers.get("X-Requested-With") !== "XMLHttpRequest") {
    throw unauthorized("Unauthorized");
  }

  const dri = extractDri(request, body);
  if (!dri) throw unauthorized("Unauthorized: droplet_installation_uuid missing");

  const company = await prisma.company.findFirst({
    where: { dropletInstallationUuid: dri, active: true },
  });
  if (!company) throw unauthorized("Unauthorized: installation not found");

  return company;
}

function extractDri(request: Request, body?: unknown): string | null {
  const fromQuery = new URL(request.url).searchParams.get("dri");
  if (fromQuery) return fromQuery;

  if (body && typeof body === "object") {
    const value = (body as Record<string, unknown>).dri;
    if (typeof value === "string" && value.length > 0) return value;
  }

  return null;
}

/**
 * Wraps a DRI-authenticated route handler.
 *
 * The auth failure response is produced by the thrower, so every endpoint
 * refuses identically — these are admin endpoints, not the checkout path, so
 * refusing loudly with a 401 is correct here.
 */
export function withDri<T>(
  handler: (company: DriCompany, body: T, request: Request) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    let body: T = undefined as T;

    if (request.method !== "GET" && request.method !== "DELETE") {
      try {
        const text = await request.text();
        body = (text ? JSON.parse(text) : {}) as T;
      } catch {
        return NextResponse.json({ error: "invalid request" }, { status: 400 });
      }
    }

    try {
      const company = await requireDriCompany(request, body);
      return await handler(company, body, request);
    } catch (error) {
      if (error instanceof DriAuthError) return error.response;
      console.error(
        "[DRI] handler failed:",
        error instanceof Error ? error.message : error,
      );
      return NextResponse.json({ error: "internal error" }, { status: 500 });
    }
  };
}

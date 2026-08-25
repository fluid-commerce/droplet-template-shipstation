/**
 * ShipStation HTTP clients.
 *
 * Port of app/services/shipstation/base_service.rb and
 * app/services/shipstation/v2/base_service.rb.
 *
 * V1 authenticates with HTTP Basic over `api_key:api_secret` and is the same
 * host for every store — the store is identified by the credentials, not the
 * URL. V2 (ShipEngine-powered) authenticates with a single `API-Key` header,
 * and sandbox is not a separate host: a `TEST_`-prefixed key targets it.
 */

import { findIntegrationSetting, secretsOf } from "@/lib/integration-settings";

export const SHIPSTATION_API_BASE = "https://ssapi.shipstation.com";
export const SHIPSTATION_V2_API_BASE = "https://api.shipstation.com/v2";

/**
 * Hosts a ShipStation-supplied `resource_url` is allowed to point at.
 *
 * The shipped webhook hands us a URL and we then fetch it with the company's
 * credentials, so an unchecked host is an SSRF that also leaks the API key.
 */
export const ALLOWED_SHIPSTATION_HOSTS = [
  "ssapi.shipstation.com",
  "ssapi6.shipstation.com",
];

export function isAllowedShipstationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      ALLOWED_SHIPSTATION_HOSTS.includes(parsed.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Raised when ShipStation keeps returning 429 after our bounded retries, so
 * callers can tell "rate limited" apart from a genuine empty result.
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export interface ShipstationCredentials {
  apiKey?: string;
  apiSecret?: string;
  v2ApiKey?: string;
}

/** Loads a company's ShipStation credentials out of its encrypted settings. */
export async function credentialsFor(companyId: bigint): Promise<ShipstationCredentials> {
  const secrets = secretsOf(await findIntegrationSetting(companyId));
  return {
    apiKey: secrets.api_key,
    apiSecret: secrets.api_secret,
    v2ApiKey: secrets.v2_api_key,
  };
}

export function v1Headers(credentials: ShipstationCredentials): HeadersInit {
  const basic = Buffer.from(
    `${credentials.apiKey ?? ""}:${credentials.apiSecret ?? ""}`,
    "utf8",
  ).toString("base64");

  return {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/json",
  };
}

export function v2Headers(apiKey: string): HeadersInit {
  return { "API-Key": apiKey, "Content-Type": "application/json" };
}

export function hasV1Credentials(credentials: ShipstationCredentials): boolean {
  return !!credentials.apiKey && !!credentials.apiSecret;
}

function withQuery(url: string, query: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const suffix = search.size > 0 ? `?${search}` : "";
  return `${url}${suffix}`;
}

const MAX_RATE_LIMIT_RETRIES = 3;

/** Wrapper around the retry wait so tests do not actually sleep. */
export async function pause(seconds: number): Promise<void> {
  if (seconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function rateLimitWaitSeconds(response: Response): number {
  const raw =
    response.headers.get("Retry-After") ?? response.headers.get("X-Rate-Limit-Reset");
  const seconds = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) : 2;
}

/**
 * GET against ShipStation V1, waiting out a 429.
 *
 * V1 caps roughly 40 requests/minute/account and answers 429 with a
 * Retry-After / X-Rate-Limit-Reset header. Going through here means a rate
 * limit is retried (boundedly) rather than surfacing as a spurious failure —
 * and, once the retries are spent, as a `RateLimitError` rather than as an
 * empty result that reads like "this order has not shipped".
 */
export async function rateLimitedGet(
  url: string,
  {
    credentials,
    query = {},
  }: {
    credentials: ShipstationCredentials;
    query?: Record<string, string | number | boolean | undefined>;
  },
): Promise<Response> {
  let attempts = 0;

  for (;;) {
    const response = await fetch(withQuery(url, query), {
      headers: v1Headers(credentials),
    });
    if (response.status !== 429) return response;

    attempts += 1;
    if (attempts > MAX_RATE_LIMIT_RETRIES) {
      throw new RateLimitError(
        `ShipStation rate limit exceeded after ${attempts} retries`,
      );
    }

    const wait = rateLimitWaitSeconds(response);
    console.warn(
      `[ShipStation] 429 rate-limited; waiting ${wait}s (retry ${attempts})`,
    );
    await pause(wait);
  }
}

export async function shipstationGet(
  path: string,
  credentials: ShipstationCredentials,
  query: Record<string, string | number | boolean | undefined> = {},
): Promise<Response> {
  return fetch(withQuery(`${SHIPSTATION_API_BASE}${path}`, query), {
    headers: v1Headers(credentials),
  });
}

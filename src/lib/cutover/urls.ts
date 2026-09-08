/**
 * URL assembly for the cutover tool.
 *
 * Extracted from scripts/cutover.ts so it can be tested: that file calls
 * `main()` at import, so importing it from a test would run the tool.
 *
 * The whole job here is refusing operator input that produces a url which
 * looks plausible, is accepted by fluid, reads back exactly as written, and
 * serves nothing.
 */

export class CutoverUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CutoverUrlError";
  }
}

/**
 * A `--url` / `--from`, reduced to a bare origin.
 *
 * A PATH IS REFUSED, not preserved. Keeping it let
 * `--url https://rails/webhook --webhook-path /webhook` build
 * `https://rails/webhook/webhook` — and because the destination probes are
 * skipped for the Rails path, nothing downstream catches it: fluid accepts the
 * update and the read-back matches, while every delivery 404s. Pasting the
 * full webhook url into --url is the obvious operator mistake, so it has to be
 * the one thing this cannot silently accept.
 *
 * The route belongs to `--webhook-path` alone.
 */
export function normaliseOrigin(value: string, flag: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CutoverUrlError(
      `${flag} must be an absolute https url; got "${value}".`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new CutoverUrlError(`${flag} must be http(s); got "${value}".`);
  }
  if (parsed.search || parsed.hash) {
    throw new CutoverUrlError(
      `${flag} must not carry a query or fragment; got "${value}".`,
    );
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new CutoverUrlError(
      `${flag} must be a bare origin with no path; got "${value}".\n\n` +
        `  The route comes from --webhook-path. Passing it here too builds\n` +
        `  "${parsed.origin}${parsed.pathname}<path>", which fluid stores and\n` +
        `  reads back exactly as given while serving nothing.`,
    );
  }
  return parsed.origin;
}

/**
 * A `--webhook-path`, checked before it is concatenated.
 *
 * A value not beginning with a single "/" is not a path: `${origin}` plus
 * "@evil.example/x" yields `https://host@evil.example/x`, whose host is
 * evil.example — the flag would be choosing the destination host.
 */
export function normalisePath(value: string, flag: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new CutoverUrlError(
      `${flag} must be an absolute path beginning with a single "/"; got "${value}".`,
    );
  }
  return value;
}

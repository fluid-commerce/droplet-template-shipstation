/**
 * Fluid's lifecycle dispatcher wraps the event in an envelope:
 *
 *   { id, identifier, name: "droplet_installed", payload: { company: {...}, resource, event, ... }, timestamp }
 *
 * The Rails controller unwrapped it (`effective_payload`). Handlers here parse a
 * top-level `company`, so the envelope is unwrapped before routing. Only a
 * body with no top-level `company` and a nested `payload.company` object is
 * unwrapped; every other shape is passed through untouched. The signature has
 * already been verified over the raw bytes, so this changes nothing about
 * what is trusted.
 */
export function unwrapLifecycleEnvelope(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if ("company" in record) return body;

  const nested = record["payload"];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return body;
  const company = (nested as Record<string, unknown>)["company"];
  if (!company || typeof company !== "object" || Array.isArray(company)) return body;

  return nested;
}

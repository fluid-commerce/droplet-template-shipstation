/**
 * Fetch helpers for the embedded UI.
 *
 * `X-Requested-With` is not decoration: browsers only allow it on same-origin
 * scripted requests, so it is what stops a cross-site form post reaching these
 * endpoints. The server requires it — see src/lib/dri.ts.
 */

export const jsonHeaders = (): HeadersInit => ({
  "Content-Type": "application/json",
  "X-Requested-With": "XMLHttpRequest",
});

export const withDri = (path: string, dri: string): string => {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}dri=${encodeURIComponent(dri)}`;
};

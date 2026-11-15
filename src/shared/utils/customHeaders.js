// Shared validation rules for custom headers
export const MAX_CUSTOM_HEADERS = 20;
export const MAX_CUSTOM_HEADER_VALUE_LENGTH = 8192;
export const CUSTOM_HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
export const BLOCKED_CUSTOM_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "authorization",
  "cookie",
]);

/**
 * Validate and clean a custom headers object.
 * Returns { headers: object|null } on success, or { error: string } on failure.
 */
export function sanitizeCustomHeaders(headers) {
  if (headers === undefined || headers === null) {
    return { headers: null };
  }
  if (typeof headers !== "object" || Array.isArray(headers)) {
    return { error: "headers must be an object" };
  }
  const entries = Object.entries(headers).filter(([, v]) => v !== "" && v != null);
  if (entries.length > MAX_CUSTOM_HEADERS) {
    return { error: `Too many headers (max ${MAX_CUSTOM_HEADERS})` };
  }
  const clean = {};
  for (const [name, value] of entries) {
    const trimmedName = String(name).trim();
    if (!CUSTOM_HEADER_NAME_RE.test(trimmedName)) {
      return { error: `Invalid header name: ${name}` };
    }
    if (typeof value !== "string" || /[\r\n]/.test(value)) {
      return { error: `Invalid value for header ${name}` };
    }
    if (value.length > MAX_CUSTOM_HEADER_VALUE_LENGTH) {
      return { error: `Header ${name} value too long (max ${MAX_CUSTOM_HEADER_VALUE_LENGTH})` };
    }
    if (BLOCKED_CUSTOM_HEADERS.has(trimmedName.toLowerCase())) {
      return { error: `Header ${name} cannot be overridden` };
    }
    clean[trimmedName] = value;
  }
  return { headers: Object.keys(clean).length > 0 ? clean : null };
}

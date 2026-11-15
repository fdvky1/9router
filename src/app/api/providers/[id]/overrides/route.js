import { NextResponse } from "next/server";
import { getSettings, updateSettings, getProviderNodeById } from "@/lib/localDb";
import { PROVIDERS } from "open-sse/config/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import {
  MAX_CUSTOM_HEADERS as MAX_HEADERS,
  MAX_CUSTOM_HEADER_VALUE_LENGTH as MAX_HEADER_VALUE_LENGTH,
  CUSTOM_HEADER_NAME_RE as HEADER_NAME_RE,
  BLOCKED_CUSTOM_HEADERS as BLOCKED_HEADERS,
  sanitizeCustomHeaders,
} from "@/shared/utils/customHeaders";

export const dynamic = "force-dynamic";

/**
 * Validate + normalize an override payload. Returns { override } or { error }.
 * An override with no headers is normalized to null (= delete).
 */
function normalizeOverride({ headers }) {
  const res = sanitizeCustomHeaders(headers);
  if (res.error) return { error: res.error };
  return { override: res.headers ? { headers: res.headers } : null };
}

async function readOverrides() {
  const settings = await getSettings();
  return settings.providerOverrides || {};
}

/**
 * GET /api/providers/[id]/overrides — user override for this provider
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    // URL may use an alias (gcli, cc…) — key everything by canonical registry id
    const canonical = resolveProviderAlias(id);
    const override = (await readOverrides())[canonical] || {};

    let builtinHeaders = PROVIDERS[canonical]?.headers || {};
    // For custom compatible nodes, fallback to node-level headers if available
    if (Object.keys(builtinHeaders).length === 0) {
      const node = await getProviderNodeById(canonical);
      if (node?.headers) {
        builtinHeaders = node.headers;
      }
    }

    // Built-in headers come straight from the registry transport (or node definition)
    return NextResponse.json({
      headers: override.headers || {},
      builtinHeaders,
    });
  } catch (error) {
    console.log("Error getting provider overrides:", error);
    return NextResponse.json({ error: "Failed to get overrides" }, { status: 500 });
  }
}

/**
 * PUT /api/providers/[id]/overrides — body: { headers: {name: value} }
 * Empty payload clears the override.
 */
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const canonical = resolveProviderAlias(id);
    const body = await request.json().catch(() => ({}));
    const { override, error } = normalizeOverride(body);
    if (error) {
      return NextResponse.json({ error }, { status: 400 });
    }
    const current = await readOverrides();
    const next = { ...current };
    if (override) next[canonical] = override;
    else delete next[canonical];
    await updateSettings({ providerOverrides: next });
    return NextResponse.json({ headers: override?.headers || {} });
  } catch (error) {
    console.log("Error saving provider overrides:", error);
    return NextResponse.json({ error: "Failed to save overrides" }, { status: 500 });
  }
}

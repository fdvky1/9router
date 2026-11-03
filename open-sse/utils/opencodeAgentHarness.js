/**
 * OpenCode free-tier request harness.
 *
 * Live probes against OpenCode v2 (`/inference/openai/v1`) show the free-tier
 * gate only admits requests carrying two artifacts of the real CLI:
 *   - its agent preamble as the system instruction, and
 *   - its full tool manifest, sent as tools.
 * A request with either one alone, or with the v1 endpoint/UA, is answered with
 * 429 FreeUsageLimitError.
 *
 * Both artifacts are mirrored from the zen-proxy repository so a change upstream
 * reaches us without a code change. The bundled snapshot is the fallback for a
 * cold cache with no network, so a request never depends on a live fetch.
 */

/** Upstream mirrors, tried in order. */
const HARNESS_SOURCES = {
  preamble: ["https://raw.githubusercontent.com/12errh/zen-proxy/main/agent-preamble.txt"],
  tools: ["https://raw.githubusercontent.com/12errh/zen-proxy/main/agent-tools.json"],
};

const FETCH_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

const cache = {
  preamble: null,
  tools: null,
  loadedAt: 0,
  inflight: null,
};

let bundled = null;

class HarnessSourceError extends Error {}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "9router" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new HarnessSourceError(`${url} -> HTTP ${response.status}`);
  return response.text();
}

async function fetchFirst(kind) {
  const errors = [];
  for (const url of HARNESS_SOURCES[kind]) {
    try {
      const text = await fetchText(url);
      if (text.trim()) return text;
      errors.push(`${url} -> empty body`);
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new HarnessSourceError(errors.join("; "));
}

/** Normalise both flat ({name}) and chat ({function:{name}}) tools to chat shape. */
export function normalizeToolManifest(raw) {
  const list = Array.isArray(raw) ? raw : raw?.tools;
  if (!Array.isArray(list)) throw new HarnessSourceError("tool manifest is not an array");
  return list
    .filter((tool) => tool && typeof tool === "object")
    .map((tool) => (tool.function ? tool : { type: "function", function: tool }))
    .filter((tool) => typeof tool.function?.name === "string" && tool.function.name);
}

function parseTools(text) {
  const tools = normalizeToolManifest(JSON.parse(text));
  if (tools.length === 0) throw new HarnessSourceError("tool manifest is empty");
  return tools;
}

async function loadBundled() {
  if (bundled) return bundled;
  const [preamble, toolsText] = await Promise.all([
    import("../assets/opencodeAgentPreamble.js").then((m) => m.OPENCODE_AGENT_PREAMBLE),
    import("../assets/opencodeAgentTools.js").then((m) => m.OPENCODE_AGENT_TOOLS),
  ]);
  bundled = { preamble, tools: parseTools(JSON.stringify(toolsText)) };
  return bundled;
}

async function loadFromUpstream() {
  const [preamble, toolsText] = await Promise.all([fetchFirst("preamble"), fetchFirst("tools")]);
  return { preamble, tools: parseTools(toolsText) };
}

async function load() {
  const hasCache = cache.preamble && cache.tools;
  const isFresh = hasCache && Date.now() - cache.loadedAt < RETRY_INTERVAL_MS;
  if (isFresh) return { preamble: cache.preamble, tools: cache.tools };

  if (cache.inflight) return cache.inflight;

  cache.inflight = (async () => {
    try {
      const loaded = await loadFromUpstream();
      cache.preamble = loaded.preamble;
      cache.tools = loaded.tools;
      cache.loadedAt = Date.now();
      return loaded;
    } catch {
      // Keep a stale-but-working cache over the snapshot: a manifest that was
      // accepted recently beats one baked in months ago.
      if (hasCache) return { preamble: cache.preamble, tools: cache.tools };
      const snapshot = await loadBundled();
      cache.preamble = snapshot.preamble;
      cache.tools = snapshot.tools;
      cache.loadedAt = Date.now();
      return snapshot;
    } finally {
      cache.inflight = null;
    }
  })();

  return cache.inflight;
}

/** The harness artifacts, from cache, upstream, or the bundled snapshot. */
export function loadAgentHarness() {
  return load();
}

/** Drop the cache so the next request re-reads upstream. */
export function resetAgentHarnessCache() {
  cache.preamble = null;
  cache.tools = null;
  cache.loadedAt = 0;
  cache.inflight = null;
}

const PREAMBLE_TAG = "You are an AI agent running in OpenCode";

function messagesCarryPreamble(body) {
  if (typeof body.instructions === "string" && body.instructions.includes(PREAMBLE_TAG)) return true;
  if (Array.isArray(body.messages)) {
    return body.messages.some(
      (message) =>
        message?.role === "system" &&
        typeof message.content === "string" &&
        message.content.includes(PREAMBLE_TAG),
    );
  }
  return false;
}

function withPreamble(body, flat, preamble) {
  if (messagesCarryPreamble(body)) return;
  if (flat) {
    body.instructions =
      typeof body.instructions === "string" && body.instructions.trim()
        ? `${preamble}\n\n${body.instructions}`
        : preamble;
    return;
  }
  if (!Array.isArray(body.messages)) body.messages = [];
  const index = body.messages.findIndex((message) => message?.role === "system");
  if (index >= 0) {
    const current = body.messages[index];
    const text = typeof current.content === "string" ? current.content : "";
    body.messages = body.messages.map((message, i) =>
      i === index
        ? { ...message, content: text.trim() ? `${preamble}\n\n${text}` : preamble }
        : message,
    );
    return;
  }
  body.messages = [{ role: "system", content: preamble }, ...body.messages];
}

function toolNameOf(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (typeof tool.name === "string" && tool.name) return tool.name;
  return typeof tool.function?.name === "string" ? tool.function.name : "";
}

/** Rewrite a chat-shape manifest tool into the flat shape the Responses lane uses. */
function toFlatTool(tool) {
  const fn = tool?.function;
  if (!fn) return tool;
  return {
    type: "function",
    name: fn.name,
    ...(fn.description ? { description: fn.description } : {}),
    parameters: fn.parameters ?? { type: "object", properties: {} },
    strict: false,
  };
}

/**
 * Merge the manifest into `tools`, keeping caller tools and never duplicating a
 * name the caller already declared.
 */
function mergeManifest(callerTools, manifest, flat) {
  const tools = Array.isArray(callerTools) ? [...callerTools] : [];
  const taken = new Set(tools.map(toolNameOf).filter(Boolean));
  for (const tool of manifest) {
    const name = toolNameOf(tool);
    if (!name || taken.has(name)) continue;
    taken.add(name);
    tools.push(flat ? toFlatTool(tool) : tool);
  }
  return tools;
}

/**
 * Make `body` carry both gate artifacts: the CLI preamble as system text and
 * the manifest as tools. Idempotent, so retries do not stack duplicates.
 */
export function applyAgentHarness(body, harness, { flat = false } = {}) {
  if (!body || typeof body !== "object" || !harness?.preamble) return false;
  withPreamble(body, flat, harness.preamble);
  body.tools = mergeManifest(body.tools, harness.tools || [], flat);
  return true;
}

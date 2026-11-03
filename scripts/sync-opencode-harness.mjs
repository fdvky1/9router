#!/usr/bin/env node
/**
 * Refresh the two captured harness artifacts from the zen-proxy mirror.
 *
 * The free-tier gate fingerprints the CLI's own request, so the capture has to be
 * the real thing rather than a paraphrase. When OpenCode ships a new harness,
 * zen-proxy re-captures it; re-running this script is how that reaches us. The
 * runtime does the same fetch on a timer (`loadAgentHarness`), so this is for
 * updating the bundled fallback that a cold cache and an offline start rely on.
 *
 * The CLI binary is not a source here. Its preamble is assembled per request from
 * context providers, so the binary holds the block formats but never a complete
 * capture - which is why `composePreamble` rebuilds those blocks instead of this
 * script extracting them.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCES = {
  preamble: "https://raw.githubusercontent.com/12errh/zen-proxy/main/agent-preamble.txt",
  tools: "https://raw.githubusercontent.com/12errh/zen-proxy/main/agent-tools.json",
};

/** Blocks `composePreamble` rewrites; a capture without them would freeze them. */
const REQUIRED_MARKERS = ["# Your Model", "Today's date:", "<env>", "</env>"];

const ASSETS = {
  preamble: "open-sse/assets/opencodeAgentPreamble.js",
  tools: "open-sse/assets/opencodeAgentTools.js",
};

const TIMEOUT_MS = 15000;

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "9router-sync" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.text();
}

function assertComposable(preamble) {
  const missing = REQUIRED_MARKERS.filter((marker) => !preamble.includes(marker));
  if (missing.length === 0) return;
  throw new Error(
    `preamble is missing ${missing.join(", ")}; composePreamble would leave those blocks frozen. ` +
      "Re-capture or update composePreamble before syncing."
  );
}

function parseTools(text) {
  const raw = JSON.parse(text);
  const list = Array.isArray(raw) ? raw : raw?.tools;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("tool manifest is not a non-empty array");
  }
  const named = list.filter((tool) => typeof (tool?.function?.name ?? tool?.name) === "string");
  if (named.length === 0) throw new Error("tool manifest has no named tools");
  return list;
}

/** A single-quoted JS literal */
function jsString(text) {
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
  return `'${escaped}'`;
}

function preambleAsset(preamble) {
  return `/** Verbatim agent preamble of the OpenCode v2 CLI, mirrored from zen-proxy.
 * Regenerate with \`npm run sync:opencode-harness\`; do not hand-edit.
 * The model, date and environment blocks are restated per request by
 * composePreamble - they are captured values, not constants. */
export const OPENCODE_AGENT_PREAMBLE =
\t${jsString(preamble)};
`;
}

function toolsAsset(tools) {
  return `/** Verbatim tool manifest of the OpenCode v2 CLI, mirrored from zen-proxy.
 * Regenerate with \`npm run sync:opencode-harness\`; do not hand-edit. */
export const OPENCODE_AGENT_TOOLS = ${JSON.stringify(tools, null, "\t")};
`;
}

async function main() {
  const [preamble, toolsText] = await Promise.all([
    fetchText(SOURCES.preamble),
    fetchText(SOURCES.tools),
  ]);
  assertComposable(preamble);
  const tools = parseTools(toolsText);

  const written = [join(process.cwd(), ASSETS.preamble), join(process.cwd(), ASSETS.tools)];
  writeFileSync(written[0], preambleAsset(preamble));
  writeFileSync(written[1], toolsAsset(tools));

  console.log(
    `synced: preamble ${preamble.length} chars, ${tools.length} tools -> ${ASSETS.preamble}, ${ASSETS.tools}`
  );
}

main().catch((error) => {
  console.error(`sync-opencode-harness: ${error.message}`);
  process.exit(1);
});

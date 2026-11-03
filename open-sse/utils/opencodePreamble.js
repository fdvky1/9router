/**
 * Rebuild the parts of the OpenCode preamble that the CLI writes per request.
 *
 * The captured harness is a frozen request. Three of its blocks are true only for
 * the moment of capture: which model was being called, what day it was, and which
 * directory the capturing machine ran in. Sent unchanged for any other model, the
 * system prompt contradicts the request body - it names `big-pickle` while the body
 * asks for something else - so these blocks are regenerated for every request.
 *
 * The formats are taken from the CLI binary (v2.1.4), not invented: the identity
 * plugin splices `# Your Model` at system index 1, and the `core/date` and
 * `core/environment` context providers render the other two.
 *
 * The static prose and the tool manifest are NOT rebuilt here. They are captured
 * artifacts that change only when OpenCode ships a new harness, and they arrive
 * through `loadAgentHarness()`.
 */

/** The directory the preamble describes the CLI running in. */
export const WORKSPACE_DIRECTORY = "/workspace";

/** The CLI's scratch directory, named in the `<env>` block it sends. */
export const TMP_DIRECTORY = "/tmp/opencode";

/** The provider id the CLI reports for its own free lane. */
const PROVIDER_ID = "opencode";

function modelBlock(identity) {
  return [
    "# Your Model",
    `- Name: ${identity.modelName}`,
    `- Provider ID: ${PROVIDER_ID}`,
    `- Model ID: ${identity.modelID}`,
  ];
}

function dateBlock(identity) {
  return [`Today's date: ${identity.today.toDateString()}`];
}

function environmentBlock(identity) {
  return [
    "<env>",
    `  Working directory: ${identity.workingDirectory}`,
    `  Workspace root folder: ${identity.workspaceRoot}`,
    `  Is directory a git repo: ${identity.isGitRepo ? "yes" : "no"}`,
    `  Platform: ${identity.platform}`,
    `  Prefer ${identity.tmpDirectory} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
    "</env>",
  ];
}

/**
 * `# Your Model` plus the bullet lines under it.
 *
 * The bullets are consumed rather than "everything up to the next heading", so a
 * capture that puts something else between the two headings keeps that something.
 */
function modelSpan(lines) {
  const start = lines.indexOf("# Your Model");
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith("- ")) end++;
  return [start, end];
}

function dateSpan(lines) {
  const start = lines.findIndex((line) => line.startsWith("Today's date:"));
  return start < 0 ? null : [start, start + 1];
}

function environmentSpan(lines) {
  const start = lines.findIndex((line) => line.trimEnd() === "<env>");
  if (start < 0) return null;
  const close = lines.findIndex((line, index) => index > start && line.trimEnd() === "</env>");
  return close < 0 ? null : [start, close + 1];
}

/**
 * Swap one span for `block`, leaving the capture untouched when the span is absent.
 *
 * Absent is the expected state after an upstream harness change: the capture is a
 * different shape and the honest answer is to send it unmodified, not to guess
 * where the block should have been.
 */
function replaceSpan(lines, span, block) {
  if (!span) return lines;
  const [start, end] = span;
  return [...lines.slice(0, start), ...block, ...lines.slice(end)];
}

/** `captured` with the model, date and environment blocks restated for this request. */
export function composePreamble(captured, identity) {
  if (typeof captured !== "string" || !captured) return captured;
  let lines = captured.split("\n");
  lines = replaceSpan(lines, modelSpan(lines), modelBlock(identity));
  lines = replaceSpan(lines, dateSpan(lines), dateBlock(identity));
  lines = replaceSpan(lines, environmentSpan(lines), environmentBlock(identity));
  return lines.join("\n");
}

/**
 * This machine's half of the identity.
 *
 * The directory is a stand-in, never the server's working directory: the outgoing
 * preamble has never named the deployment path, and doing so would tell a third
 * party what the operator's project is called. `opencode-session.test.ts` pins
 * that. The two paths are shared with the fingerprint's own `<env>` block, which
 * used to spell them out separately - one request could describe two different
 * directories depending on whether the harness cache was warm.
 */
export function environmentIdentity() {
  return {
    workingDirectory: WORKSPACE_DIRECTORY,
    workspaceRoot: WORKSPACE_DIRECTORY,
    isGitRepo: false,
    platform: process.platform,
    tmpDirectory: TMP_DIRECTORY,
  };
}

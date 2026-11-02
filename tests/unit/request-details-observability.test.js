import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalObsEnabled = process.env.OBSERVABILITY_ENABLED;
const originalObsRedacted = process.env.OBSERVABILITY_REDACTED;
const originalReqLogs = process.env.ENABLE_REQUEST_LOGS;

let tempDir;
let db;
let GET;

function makeReq(query = "page=1&pageSize=20") {
  return new Request(`http://localhost/api/usage/request-details?${query}`);
}

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-obs-test-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
  ({ GET } = await import("@/app/api/usage/request-details/route.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;

  if (originalObsEnabled === undefined) delete process.env.OBSERVABILITY_ENABLED;
  else process.env.OBSERVABILITY_ENABLED = originalObsEnabled;

  if (originalObsRedacted === undefined) delete process.env.OBSERVABILITY_REDACTED;
  else process.env.OBSERVABILITY_REDACTED = originalObsRedacted;

  if (originalReqLogs === undefined) delete process.env.ENABLE_REQUEST_LOGS;
  else process.env.ENABLE_REQUEST_LOGS = originalReqLogs;
});

beforeEach(() => {
  delete process.env.OBSERVABILITY_ENABLED;
  delete process.env.OBSERVABILITY_REDACTED;
  delete process.env.ENABLE_REQUEST_LOGS;
});

describe("Request details payload visibility with Observability", () => {
  it("returns full unredacted payloads when enableObservability is true", async () => {
    await db.updateSettings({ enableObservability: true, observabilityBatchSize: 1 });

    const sampleDetail = {
      id: "obs-detail-1",
      provider: "openai",
      model: "gpt-4o",
      status: "success",
      tokens: { prompt_tokens: 15, completion_tokens: 8 },
      request: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What is quantum computing?" }],
        temperature: 0.7,
      },
      providerRequest: {
        model: "gpt-4o",
        messages: [{ role: "user", content: "What is quantum computing?" }],
      },
      providerResponse: {
        id: "chatcmpl-123",
        choices: [{ message: { content: "Quantum computing uses qubits..." } }],
      },
      response: {
        content: "Quantum computing uses qubits...",
        thinking: null,
        finish_reason: "stop",
      },
    };

    await db.saveRequestDetail(sampleDetail);
    await new Promise((r) => setTimeout(r, 120));

    const res = await GET(makeReq("page=1&pageSize=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const hit = body.details.find((d) => d.id === "obs-detail-1");
    expect(hit).toBeDefined();

    // Check all 4 sections are returned in full
    expect(hit.request).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What is quantum computing?" }],
      temperature: 0.7,
    });
    expect(hit.providerRequest).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "What is quantum computing?" }],
    });
    expect(hit.providerResponse).toEqual({
      id: "chatcmpl-123",
      choices: [{ message: { content: "Quantum computing uses qubits..." } }],
    });
    expect(hit.response).toEqual({
      content: "Quantum computing uses qubits...",
      thinking: null,
      finish_reason: "stop",
    });
  });

  it("redacts payloads when enableObservability is false", async () => {
    await db.updateSettings({ enableObservability: false, observabilityBatchSize: 1 });

    const res = await GET(makeReq("page=1&pageSize=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const hit = body.details.find((d) => d.id === "obs-detail-1");
    expect(hit).toBeDefined();

    // Metadata is preserved
    expect(hit.model).toBe("gpt-4o");
    expect(hit.tokens).toEqual({ prompt_tokens: 15, completion_tokens: 8 });

    // Payload fields are redacted to { redacted: true }
    expect(hit.request).toEqual({ redacted: true });
    expect(hit.providerRequest).toEqual({ redacted: true });
    expect(hit.providerResponse).toEqual({ redacted: true });
    expect(hit.response).toEqual({ redacted: true });
  });

  it("un-redacts when OBSERVABILITY_ENABLED=true even if settings has false", async () => {
    await db.updateSettings({ enableObservability: false });
    process.env.OBSERVABILITY_ENABLED = "true";

    const res = await GET(makeReq("page=1&pageSize=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const hit = body.details.find((d) => d.id === "obs-detail-1");
    expect(hit).toBeDefined();
    expect(hit.request.model).toBe("gpt-4o");
    expect(hit.response.content).toContain("Quantum computing");
  });

  it("forces redaction when OBSERVABILITY_REDACTED=true even if enableObservability is true", async () => {
    await db.updateSettings({ enableObservability: true });
    process.env.OBSERVABILITY_REDACTED = "true";

    const res = await GET(makeReq("page=1&pageSize=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const hit = body.details.find((d) => d.id === "obs-detail-1");
    expect(hit).toBeDefined();
    expect(hit.request).toEqual({ redacted: true });
    expect(hit.response).toEqual({ redacted: true });
  });
});

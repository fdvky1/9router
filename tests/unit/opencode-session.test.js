import { beforeEach, describe, expect, it, vi } from "vitest"

const { fetchMock, opencodeTlsFetchMock } = vi.hoisted(() => ({
	fetchMock: vi.fn(),
	opencodeTlsFetchMock: vi.fn(),
}))

vi.mock("open-sse/utils/proxyFetch.js", () => ({
	proxyAwareFetch: fetchMock,
}))
vi.mock("open-sse/services/opencodeTlsClient.js", () => ({
	opencodeTlsFetch: opencodeTlsFetchMock,
	OpencodeTlsUnavailableError: class OpencodeTlsUnavailableError extends Error {},
}))

import {
	getModelTargetFormat,
	isValidModel,
} from "open-sse/config/providerModels.js"
import { getExecutor, hasSpecializedExecutor } from "open-sse/executors/index.js"
import {
	generateSessionId,
	OPENCODE_SESSION_RE,
	stableSessionId,
	translateSessionId,
} from "open-sse/executors/opencode.js"
import {
	generateSessionId as generateZenSessionId,
	translateSessionId as translateZenSessionId,
} from "open-sse/executors/opencode-zen.js"

function makeCredentials(overrides = {}) {
	return {
		connectionId: "conn_test",
		rawHeaders: {},
		...overrides,
	}
}

function prepare(executor, overrides = {}) {
	const credentials = overrides.credentials || makeCredentials()
	const prepared = executor.prepareRequestCredentials({
		body: overrides.body || {
			input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
		},
		credentials,
		providerSessionId: overrides.providerSessionId ?? "conversation-a",
		clientTool: overrides.clientTool ?? "claude",
	})
	return { credentials, prepared }
}

beforeEach(() => {
	fetchMock.mockReset()
	fetchMock.mockResolvedValue(
		new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	)
	opencodeTlsFetchMock.mockResolvedValue(
		new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	)
})

describe("OpenCode Free Session ID Format", () => {
	it("generates session IDs matching OpenCode canonical format (ses_ + 12 hex + 14 base62)", () => {
		for (let i = 0; i < 20; i++) {
			const id = generateSessionId()
			expect(id).toMatch(OPENCODE_SESSION_RE)
			expect(id).toHaveLength(30)
		}
	})

	it("translates arbitrary sessions into valid OpenCode session format", () => {
		const inputs = [
			"claude:550e8400-e29b-41d4-a716-446655440000",
			"antigravity:conv-abc-123",
			"session-from-codex",
			"12345",
			"",
		]
		for (const raw of inputs) {
			const translated = translateSessionId(raw, "claude")
			expect(translated).toMatch(OPENCODE_SESSION_RE)
			expect(translated).toHaveLength(30)
		}
	})

	// Upstream decodes the prefix as ~(time * 0x1000 + counter) and answers
	// 403 FreeTierError unless the counter is small; hash-filled prefixes failed.
	it("encodes a small counter in session prefixes so the free-tier gate accepts them", () => {
		const counterOf = (id) => Number(~BigInt(`0x${id.slice(4, 16)}`) & 0xfffn)
		for (const translate of [translateSessionId, translateZenSessionId]) {
			for (const raw of [
				"claude:550e8400-e29b-41d4-a716-446655440000",
				"session-from-codex",
				"",
				"x".repeat(300),
			]) {
				const translated = translate(raw, "claude")
				expect(translated).toMatch(OPENCODE_SESSION_RE)
				expect(counterOf(translated)).toBe(1)
				expect(translate(raw, "claude")).toBe(translated)
			}
		}
		expect(counterOf(generateSessionId(1_700_000_000_000))).toBeLessThanOrEqual(16)
		expect(counterOf(generateZenSessionId(1_700_000_000_000))).toBe(1)
	})

	it("mints translated sessions at the current time and reuses them per conversation", () => {
		const timeOf = (id) => Number((~BigInt(`0x${id.slice(4, 16)}`) & ((1n << 48n) - 1n)) >> 12n)
		const now = Date.now()
		const session = translateSessionId(`conversation-${now}`, "claude")
		const translatedTime = timeOf(session)
		expect(translatedTime).toBeGreaterThanOrEqual(Number(BigInt(now) & ((1n << 36n) - 1n)))
		expect(translatedTime).toBeLessThanOrEqual(Number(BigInt(Date.now()) & ((1n << 36n) - 1n)))
		expect(translateSessionId(`conversation-${now}`, "claude")).toBe(session)
	})

	it("preserves already-valid OpenCode sessions without re-hashing", () => {
		const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc"
		expect(translateSessionId(valid)).toBe(valid)
		expect(translateSessionId(`  ${valid}  `)).toBe(valid)
	})
})

describe("OpenCode Free Executor Session Resolution", () => {
	it("uses request-local session credentials without mutating source credentials", () => {
		const executor = getExecutor("opencode")
		const { credentials, prepared } = prepare(executor)

		expect(executor.constructor.name).toBe("OpenCodeExecutor")
		expect(prepared).not.toBe(credentials)
		expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE)
		expect(credentials).not.toHaveProperty("_opencodeSession")
		expect(executor).not.toHaveProperty("_currentSessionId")
	})

	it("preserves valid native x-opencode-session header case-insensitively", () => {
		const executor = getExecutor("opencode")
		const valid = "ses_f534dfae8ffeCy4Ee4tLWNygDc"
		const { prepared } = prepare(executor, {
			credentials: makeCredentials({ rawHeaders: { "X-OpenCode-Session": ` ${valid} ` } }),
		})

		expect(prepared._opencodeSession).toBe(valid)
	})

	it("translates invalid native x-opencode-session header into a valid session", () => {
		const executor = getExecutor("opencode")
		const { prepared } = prepare(executor, {
			credentials: makeCredentials({ rawHeaders: { "x-opencode-session": "invalid-session-uuid" } }),
		})

		expect(prepared._opencodeSession).toMatch(OPENCODE_SESSION_RE)
		expect(prepared._opencodeSession).not.toBe("invalid-session-uuid")
	})

	it("translates conversation session deterministically", () => {
		const executor = getExecutor("opencode")
		const first = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" })
			.prepared._opencodeSession
		const second = prepare(executor, { providerSessionId: "conversation-a", clientTool: "claude" })
			.prepared._opencodeSession

		expect(first).toBe(second)
		expect(first).toMatch(OPENCODE_SESSION_RE)
	})

	it("isolates different conversations and tools", () => {
		const executor = getExecutor("opencode")
		const convA = prepare(executor, { providerSessionId: "conversation-a" }).prepared._opencodeSession
		const convB = prepare(executor, { providerSessionId: "conversation-b" }).prepared._opencodeSession
		const toolClaude = prepare(executor, { providerSessionId: "same", clientTool: "claude" }).prepared
			._opencodeSession
		const toolCodex = prepare(executor, { providerSessionId: "same", clientTool: "codex" }).prepared
			._opencodeSession

		expect(convA).not.toBe(convB)
		expect(toolClaude).not.toBe(toolCodex)
	})

	it("adds the valid session header to fetch requests", async () => {
		const executor = getExecutor("opencode")
		const credentials = makeCredentials()
		const result = await executor.execute({
			model: "muse-spark-1.3-contributor-free",
			body: {
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
			},
			stream: false,
			credentials,
			providerSessionId: "conversation-fetch-test",
			clientTool: "claude",
		})

		expect(result.headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE)
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(fetchMock.mock.calls[0][1].headers["x-opencode-session"]).toBe(
			result.headers["x-opencode-session"],
		)
		expect(fetchMock.mock.calls[0][1].headers["Authorization"]).toBe("Bearer public")
		expect(fetchMock.mock.calls[0][3]).toBeTypeOf("function")
		expect(credentials).not.toHaveProperty("_opencodeSession")

		await fetchMock.mock.calls[0][3](
			"https://opencode.ai/inference/openai/v1/responses",
			fetchMock.mock.calls[0][1],
		)
		expect(opencodeTlsFetchMock).toHaveBeenCalledOnce()
	})

	it("falls back to a valid generated session in buildHeaders when called standalone", () => {
		const executor = getExecutor("opencode")
		const headers = executor.buildHeaders({})

		expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE)
		expect(headers["Authorization"]).toBe("Bearer public")
	})
	it("handles null or undefined body gracefully in transformRequest", () => {
		const executor = getExecutor("opencode")
		expect(() =>
			executor.transformRequest("muse-spark-1.3-contributor-free", null, false, {}),
		).not.toThrow()
		expect(() => executor.transformRequest("big-pickle", undefined, false, {})).not.toThrow()
	})
})

describe("OpenCode Free User-Agent Validation", () => {
	it("defaults User-Agent to the current CLI form for non-opencode downstream clients", () => {
		const executor = getExecutor("opencode")
		const headersNoUa = executor.buildHeaders({})
		expect(headersNoUa["User-Agent"]).toBe("opencode/latest/2.1.4/cli")

		const headersClaude = executor.buildHeaders({ rawHeaders: { "user-agent": "Claude-Code/1.0" } })
		expect(headersClaude["User-Agent"]).toBe("opencode/latest/2.1.4/cli")
	})

	it("replaces stale opencode User-Agents, which upstream now rejects with 403", () => {
		const executor = getExecutor("opencode")
		for (const ua of ["opencode", "opencode/1.15.0", "opencode/latest/2.0.26/cli"]) {
			expect(executor.buildHeaders({ rawHeaders: { "user-agent": ua } })["User-Agent"]).toBe(
				"opencode/latest/2.1.4/cli",
			)
		}
	})

	it("preserves a current opencode downstream User-Agent", () => {
		const executor = getExecutor("opencode")
		const headers = executor.buildHeaders({
			rawHeaders: { "user-agent": "opencode/latest/2.1.4/cli" },
		})
		expect(headers["User-Agent"]).toBe("opencode/latest/2.1.4/cli")
	})

	it("sends fetch-route session-affinity headers without a per-message CLI request id", () => {
		const executor = getExecutor("opencode")
		const headers = executor.buildHeaders({})
		const session = headers["x-opencode-session"]
		expect(session).toMatch(OPENCODE_SESSION_RE)
		expect(headers["x-opencode-session-id"]).toBe(session)
		expect(headers["x-opencode-client"]).toBe("cli")
		expect(headers["x-opencode-request"]).toBeUndefined()
		expect(headers["x-session-affinity"]).toBe(session)
		expect(headers["x-session-id"]).toBe(session)
	})
})

describe("OpenCode Stable Session Reuse (429 follow-up)", () => {
	function anonymousCredentials(auth) {
		return makeCredentials({
			connectionId: undefined,
			rawHeaders: { authorization: `Bearer ${auth}` },
		})
	}

	it("reuses one stable upstream session instead of minting a new one per request", () => {
		const executor = getExecutor("opencode")
		const body = { messages: [{ role: "user", content: "hello" }] }
		const first = executor.prepareRequestCredentials({
			body,
			credentials: anonymousCredentials("stable-key-1"),
			providerSessionId: null,
			clientTool: "claude",
		})
		const second = executor.prepareRequestCredentials({
			body,
			credentials: anonymousCredentials("stable-key-1"),
			providerSessionId: null,
			clientTool: "claude",
		})

		expect(first._opencodeSession).toMatch(OPENCODE_SESSION_RE)
		expect(second._opencodeSession).toBe(first._opencodeSession)
	})

	it("isolates stable sessions by downstream identity", () => {
		const executor = getExecutor("opencode")
		const body = { messages: [{ role: "user", content: "hello" }] }
		const forKey = (auth) =>
			executor.prepareRequestCredentials({
				body,
				credentials: anonymousCredentials(auth),
				providerSessionId: null,
				clientTool: "claude",
			})._opencodeSession

		expect(forKey("user-A")).not.toBe(forKey("user-B"))
		expect(forKey("user-A")).toMatch(OPENCODE_SESSION_RE)
	})

	it("exposes the stable session helper directly", () => {
		const first = stableSessionId({ connectionId: "direct-conn" })
		expect(stableSessionId({ connectionId: "direct-conn" })).toBe(first)
		expect(first).toMatch(OPENCODE_SESSION_RE)
	})

	it("keeps the standalone buildHeaders session stable across calls", () => {
		const executor = getExecutor("opencode")
		const first = executor.buildHeaders({})["x-opencode-session"]
		const second = executor.buildHeaders({})["x-opencode-session"]
		expect(first).toMatch(OPENCODE_SESSION_RE)
		expect(second).toBe(first)
	})

	it("applies the read/shell free-tier fingerprint on Chat Completions", () => {
		const executor = getExecutor("opencode")

		const chatNoTools = executor.transformRequest("nemotron-3-ultra-free", {
			messages: [{ role: "user", content: "hi" }],
		})
		expect(chatNoTools.stream).toBe(true)
		// tool_choice "none" is answered with 403 FreeTierError upstream.
		expect(chatNoTools.tool_choice).toBeUndefined()
		expect(chatNoTools.tools.map((t) => t.function?.name)).toEqual([
			"read",
			"shell",
			"edit",
			"glob",
			"grep",
			"question",
			"skill",
			"subagent",
			"webfetch",
			"websearch",
			"write",
			"execute",
		])
		expect(chatNoTools.messages[0].role).toBe("system")
		expect(chatNoTools.messages[0].content).toContain("<env>")
		expect(chatNoTools.messages[0].content).toContain("Working directory: /workspace")
		expect(chatNoTools.messages[0].content).not.toContain(process.cwd())

		const chatWithTools = executor.transformRequest("nemotron-3-ultra-free", {
			messages: [{ role: "user", content: "hi" }],
			tools: [
				{ type: "function", function: { name: "Bash", description: "Claude Code tool" } },
				{ type: "function", function: { name: "Read", description: "Claude Code tool" } },
			],
			tool_choice: "auto",
		})
		expect(chatWithTools.tool_choice).toBe("auto")
		expect(chatWithTools.tools.map((t) => t.function?.name)).toEqual([
			"Bash",
			"Read",
			"read",
			"shell",
			"edit",
			"glob",
			"grep",
			"question",
			"skill",
			"subagent",
			"webfetch",
			"websearch",
			"write",
			"execute",
		])

		const chatClash = executor.transformRequest("nemotron-3-ultra-free", {
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "read", description: "existing" } }],
		})
		expect(chatClash.tools.slice(0, 3).map((t) => t.function?.name)).toEqual([
			"read_client",
			"read",
			"shell",
		])
		expect(chatClash.tools[0].function.description).toBe("existing")
	})

	it("cloaks Muse Responses requests even when the client already supplies tools", () => {
		const executor = getExecutor("opencode")
		const transformed = executor.transformRequest(
			"muse-spark-1.3-contributor-free(xhigh)",
			{
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
				tools: [
					{
						type: "function",
						name: "zcode_search",
						description: "client-provided tool",
						parameters: { type: "object", properties: {} },
					},
				],
				tool_choice: "auto",
				reasoning_effort: "xhigh",
			},
			true,
			{},
		)

		expect(transformed.stream).toBe(true)
		expect(transformed.reasoning?.effort).toBe("xhigh")
		expect(transformed.tools.slice(0, 3).map((tool) => tool.name)).toEqual([
			"zcode_search",
			"read",
			"shell",
		])
		expect(transformed.instructions).toContain("<env>")
		expect(transformed.instructions).not.toContain(process.cwd())
	})

	it("declares forceStream on the opencode transport so chatCore serves SSE upstream", async () => {
		const { PROVIDERS } = await import("open-sse/config/providers.js")
		expect(PROVIDERS.opencode?.forceStream).toBe(true)
		expect(PROVIDERS.opencode?.retry?.[502]?.attempts).toBe(0)
		expect(PROVIDERS.opencode?.retry?.[503]?.attempts).toBe(0)
	})

	it("keeps opencode as the single HTTP provider with no native CLI variant", async () => {
		const opencode = getExecutor("opencode")
		expect(hasSpecializedExecutor("opencode")).toBe(true)
		expect(opencode.constructor.name).toBe("OpenCodeExecutor")
		// The CLI-backed v2 lane is gone: no provider or alias may resolve to it.
		expect(hasSpecializedExecutor("opencode-v2")).toBe(false)
		expect(hasSpecializedExecutor("oc2")).toBe(false)
		expect(isValidModel("oc2", "union-alpha")).toBe(false)
		expect(getModelTargetFormat("oc2", "union-alpha")).toBe(null)
		// The surviving lane still resolves every alias to one executor.
		expect(getExecutor("oc1").constructor.name).toBe("OpenCodeExecutor")
		expect(getExecutor("oc").constructor.name).toBe("OpenCodeExecutor")
		// Endpoint-family routing still applies to unknown/open-lane model ids.
		expect(getModelTargetFormat("opencode", "union-alpha")).toBe("claude")

		const headers = opencode.buildHeaders(
			{},
			true,
			"https://opencode.ai/inference/openai/v1/chat/completions",
		)
		expect(headers["User-Agent"]).toBe("opencode/latest/2.1.4/cli")
		expect(headers["x-opencode-client"]).toBe("cli")
		expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
		expect(headers["x-session-affinity"]).toBe(headers["x-opencode-session"])
		expect(headers["x-session-id"]).toBe(headers["x-opencode-session"])

		const url = opencode.buildUrl("deepseek-v4.1-flash-free")
		expect(url).toBe("https://opencode.ai/inference/openai/v1/chat/completions")

		const msgUrl = opencode.buildUrl("union-alpha")
		expect(msgUrl).toBe("https://opencode.ai/inference/openai/v1/messages")
		expect(opencode.getProvider()).toBe("opencode")
	})

	it("serves the free lane over HTTP through the TLS client, never a spawned CLI", async () => {
		const opencode = getExecutor("opencode")
		const result = await opencode.execute({
			model: "big-pickle",
			body: { messages: [{ role: "user", content: "hello" }] },
			credentials: { connectionId: "connection-http" },
		})

		expect(fetchMock).toHaveBeenCalledOnce()
		expect(result.url).toBe("https://opencode.ai/inference/openai/v1/chat/completions")
		// The free tier gates on the real CLI TLS fingerprint, so every direct
		// attempt must go through the wreq-js transport rather than plain fetch.
		opencodeTlsFetchMock.mockClear()
		await fetchMock.mock.calls[0][3]("https://opencode.ai/inference/openai/v1/chat/completions", {})
		expect(opencodeTlsFetchMock).toHaveBeenCalledOnce()
	})
})

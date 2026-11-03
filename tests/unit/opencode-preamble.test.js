import { describe, expect, it } from "vitest"
import { OPENCODE_AGENT_PREAMBLE } from "open-sse/assets/opencodeAgentPreamble.js"
import { OPENCODE_AGENT_TOOLS } from "open-sse/assets/opencodeAgentTools.js"
import { getExecutor } from "open-sse/executors/index.js"
import {
	composePreamble,
	environmentIdentity,
} from "open-sse/utils/opencodePreamble.js"

// The capture is a real CLI request, so it names the model, date and directory of
// the machine it came from. Composition restates those three blocks for the
// request actually being sent; everything else is the captured harness verbatim.

const identity = {
	...environmentIdentity(),
	modelName: "GLM 5.3 Flash",
	modelID: "glm-5.3-flash-free",
	today: new Date(2026, 10, 1),
}

describe("preamble composition", () => {
	it("states the model this request asks for", () => {
		const composed = composePreamble(OPENCODE_AGENT_PREAMBLE, identity)

		expect(composed).toContain(
			"# Your Model\n- Name: GLM 5.3 Flash\n- Provider ID: opencode\n- Model ID: glm-5.3-flash-free\n",
		)
		expect(composed).not.toContain("Big Pickle")
		expect(composed).not.toContain("big-pickle")
	})

	it("restates the capture date as today", () => {
		const composed = composePreamble(OPENCODE_AGENT_PREAMBLE, identity)

		expect(composed).toContain("Today's date: Sun Nov 01 2026")
		expect(composed).not.toContain("Today's date: Sun Oct 25 2026")
	})

	it("describes a CLI workspace without disclosing the deployment path", () => {
		const composed = composePreamble(OPENCODE_AGENT_PREAMBLE, identity)

		expect(composed).toContain(`  Working directory: ${identity.workingDirectory}`)
		expect(composed).toContain(`  Platform: ${process.platform}`)
		expect(composed).not.toContain("/tmp/opencode/fhome")
		// The outgoing preamble never names the operator's project (opencode-session.test.ts).
		expect(composed).not.toContain(process.cwd())
	})

	it("keeps the harness prose and the line count", () => {
		const composed = composePreamble(OPENCODE_AGENT_PREAMBLE, identity)

		// Every rebuilt block is the same height as the one it replaces, so an equal
		// line count is the cheap proof that nothing else was dropped or duplicated.
		expect(composed.split("\n")).toHaveLength(OPENCODE_AGENT_PREAMBLE.split("\n").length)
		expect(composed).toContain("Responses are rendered as GitHub-flavored Markdown")
		expect(composed).toContain("# Code Mode")
	})

	it("is idempotent", () => {
		const once = composePreamble(OPENCODE_AGENT_PREAMBLE, identity)

		expect(composePreamble(once, identity)).toBe(once)
	})

	it("leaves a capture it does not recognise alone", () => {
		const foreign = "# Harness\nA future harness with none of the captured blocks."

		expect(composePreamble(foreign, identity)).toBe(foreign)
	})

	it("rebuilds only the blocks the capture still has", () => {
		const partial =
			"# Your Model\n- Name: Old\n- Provider ID: opencode\n- Model ID: old\nToday's date: Mon Jan 01 2024\n"
		const composed = composePreamble(partial, identity)

		expect(composed).toContain("- Model ID: glm-5.3-flash-free")
		expect(composed).toContain("Today's date: Sun Nov 01 2026")
		expect(composed).not.toContain("<env>")
	})
})

describe("captured snapshot", () => {
	// Composition is silent when a block is absent, by design. This is the alarm
	// that a re-capture changed shape and every request is back to stating the
	// captured model and date.
	it("carries the blocks composition rewrites", () => {
		for (const marker of ["# Your Model", "Today's date:", "<env>", "</env>"]) {
			expect(OPENCODE_AGENT_PREAMBLE).toContain(marker)
		}
	})
})

describe("executor wiring", () => {
	// The module tests above pass whether or not the executor calls it. This is the
	// one that fails if `transformRequest` ever hands `applyAgentHarness` the raw
	// capture again.
	it("sends the composed preamble, not the capture", () => {
		const executor = getExecutor("opencode")
		executor.harness = {
			preamble: OPENCODE_AGENT_PREAMBLE,
			tools: [...OPENCODE_AGENT_TOOLS],
		}

		const body = executor.transformRequest("glm-5.3-flash-free", {
			messages: [{ role: "user", content: "hi" }],
		})

		expect(body.messages[0].role).toBe("system")
		expect(body.messages[0].content).toContain("- Model ID: glm-5.3-flash-free")
		expect(body.messages[0].content).not.toContain("big-pickle")
	})
})

import { describe, expect, it } from "vitest";
import { modelIdSpellings, resolveProviderAlias } from "open-sse/services/model.js";

describe("model id spellings", () => {
  it("resolves every alias of the opencode lane to its provider id", () => {
    expect(resolveProviderAlias("oc")).toBe("opencode");
    expect(resolveProviderAlias("oc1")).toBe("opencode");
    expect(resolveProviderAlias("opencode")).toBe("opencode");
  });

  it("lists the alias, the canonical id and the legacy alias for one model", () => {
    const spellings = modelIdSpellings("oc1/big-pickle");
    expect(spellings).toContain("oc1/big-pickle");
    expect(spellings).toContain("oc/big-pickle");
    expect(spellings).toContain("opencode/big-pickle");
  });

  it("leaves a bare model name and an unknown provider untouched", () => {
    expect(modelIdSpellings("big-pickle")).toEqual(["big-pickle"]);
    expect(modelIdSpellings("not-a-provider/some-model")).toEqual(["not-a-provider/some-model"]);
  });

  it("does not invent spellings for a provider with no other names", () => {
    expect(modelIdSpellings("openai/gpt-4")).toEqual(["openai/gpt-4"]);
  });
});

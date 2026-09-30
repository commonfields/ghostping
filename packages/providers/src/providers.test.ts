// Hosted V1 provider boundary: ONLY `mock` and `9router` are enabled.
// Direct integrations (openai/anthropic/gemini/...) must fail before any
// network-capable path. This test pins that boundary.
import { describe, expect, it } from "vitest"
import { SUPPORTED_HOSTED_PROVIDERS, isSupportedProvider } from "./index.js"

describe("hosted provider boundary (mock + 9router only, no direct providers)", () => {
  it("supports exactly mock and 9router", () => {
    expect([...SUPPORTED_HOSTED_PROVIDERS]).toEqual(["mock", "9router"])
    expect(isSupportedProvider("mock")).toBe(true)
    expect(isSupportedProvider("9router")).toBe(true)
  })

  it("rejects every direct provider before any network-capable path", () => {
    for (const p of ["openai", "anthropic", "gemini", "perplexity", "OPENAI", "Mock", ""]) {
      expect(isSupportedProvider(p)).toBe(false)
    }
  })
})

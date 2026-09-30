// Hosted V1 provider boundary: ONLY `mock` is enabled. This test pins the
// boundary so a non-mock provider can never silently reach a network path.
import { describe, expect, it } from "vitest"
import { SUPPORTED_HOSTED_PROVIDERS, isSupportedProvider } from "./index.js"

describe("hosted provider boundary (mock only, no network)", () => {
  it("supports exactly provider=mock", () => {
    expect([...SUPPORTED_HOSTED_PROVIDERS]).toEqual(["mock"])
    expect(isSupportedProvider("mock")).toBe(true)
  })

  it("rejects every non-mock provider before any network-capable path", () => {
    for (const p of ["openai", "anthropic", "gemini", "perplexity", "OPENAI", "Mock", ""]) {
      expect(isSupportedProvider(p)).toBe(false)
    }
  })
})

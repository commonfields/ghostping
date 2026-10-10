import { describe, expect, it } from "vitest"
import { makeLiveSearchConsoleProvider } from "../src/gsc.js"

describe("deferred Search Console integration", () => {
  it("does not claim a connection or successful property read from credentials alone", async () => {
    const provider = makeLiveSearchConsoleProvider({ credentialsPresent: true })
    expect(await provider.status()).toMatchObject({ status: "BLOCKED_NOT_IMPLEMENTED" })
    await expect(provider.listProperties()).rejects.toThrow("not implemented")
    await expect(provider.inspectUrl("TEST-property", "https://example.test")).rejects.toThrow("not implemented")
  })
  it("distinguishes missing credentials from the unimplemented integration", async () => {
    const provider = makeLiveSearchConsoleProvider({ credentialsPresent: false })
    expect(await provider.status()).toMatchObject({ status: "BLOCKED_MISSING_CREDENTIALS" })
    await expect(provider.listProperties()).rejects.toThrow("credentials unavailable")
  })
})

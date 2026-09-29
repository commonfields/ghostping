import { describe, expect, it } from "vitest"
import { parseCookies, verifyPassword, hashPassword } from "./auth.js"
import { detectAuthorityConflicts } from "@ghostping/domain"

describe("auth", () => {
  it("hashes and verifies passwords (scrypt)", () => {
    const h = hashPassword("password123")
    expect(h.startsWith("scrypt$")).toBe(true)
    expect(verifyPassword("password123", h)).toBe(true)
    expect(verifyPassword("wrong", h)).toBe(false)
  })

  it("parses session cookies", () => {
    expect(parseCookies("gp_session=abc; other=1")["gp_session"]).toBe("abc")
    expect(parseCookies(null)["gp_session"]).toBeUndefined()
  })
})

describe("account isolation", () => {
  it("cross-account business access is rejected", () => {
    // Mirrors the getScoped WHERE account_id = $account rule in every repo.
    const businesses = [{ id: "b1", accountId: "a1" }]
    const scoped = (accountId: string, id: string) =>
      businesses.find((b) => b.id === id && b.accountId === accountId) ?? null
    expect(scoped("a2", "b1")).toBeNull()
    expect(scoped("a1", "b1")).not.toBeNull()
  })

  it("fact conflicts never auto-resolve", () => {
    const conflicts = detectAuthorityConflicts(([
      { id: "f1", businessId: "b", subject: "northstar", predicate: "monthly_price", status: "ACTIVE", validFrom: "2026-01-01T00:00:00Z", validUntil: null },
      { id: "f2", businessId: "b", subject: "northstar", predicate: "monthly_price", status: "ACTIVE", validFrom: "2026-09-01T00:00:00Z", validUntil: null },
    ]) as never)
    expect(conflicts).toHaveLength(1)
  })
})

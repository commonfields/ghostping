import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
const root = fileURLToPath(new URL("../../../", import.meta.url))
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (["node_modules", "dist", ".git"].includes(entry.name)) return []
  const path = join(dir, entry.name)
  return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) && !path.includes(".test.") ? [path] : []
})
describe("assay human review boundary", () => {
  it("worker and engineering scripts have no assay review service or writes", () => {
    for (const path of [...sources(join(root, "apps/worker/src")), ...sources(join(root, "scripts")), join(root, "packages/db/src/seed.ts")]) {
      const content = readFileSync(path, "utf8")
      expect(content, path).not.toMatch(/AssayReviewRepository|assay_finding_reviews|reviewFact\s*\(|reviewFinding\s*\(|reviewed_by|review_reason/)
    }
  })
  it("API errors expose no database failure details and do no network fetching", () => {
    const routes = readFileSync(join(root, "apps/api/src/assay-routes.ts"), "utf8")
    expect(routes).not.toMatch(/safeFetch|\bfetch\s*\(|json\([^\n]*, e\b/)
    expect(routes).toContain("requestedBy: session.userId")
    expect(routes).toContain("reviewFact(session")
    expect(routes).toContain("reviewFinding(session")
  })
})

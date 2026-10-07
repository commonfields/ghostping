import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
const root = fileURLToPath(new URL("../../../", import.meta.url))
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (["node_modules", "dist", ".git"].includes(entry.name)) return []
  const path = join(dir, entry.name)
  return entry.isDirectory() ? sources(path) : /\.[cm]?tsx?$/.test(path) && !path.includes(".test.") ? [path] : []
})
describe("hosted Effect architecture guards", () => {
  it("has no Rust execution, subprocess, or IPC dependency in hosted sources", () => {
    for (const path of [...sources(join(root, "apps")), ...sources(join(root, "packages"))]) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/child_process|\bspawn\s*\(|RustObservationWorker|GHOSTPING_WORKER_PATH|openrecord-worker-(job|result)-v1|target\/(debug|release)\/openrecord-worker/)
    }
  })
  it("providers use injectable HTTP and Config capabilities without direct globals", () => {
    for (const path of sources(join(root, "packages/providers/src"))) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/process\.env|\bfetch\s*\(|node:https?|axios|undici/)
    }
    const nine = readFileSync(join(root, "packages/providers/src/nine-router.ts"), "utf8")
    expect(nine).toContain("Schema.decodeUnknown")
    expect(nine).toContain("http.execute")
    expect(nine).toContain("response.stream")
    expect(nine).not.toMatch(/response\.json\(|response\.arrayBuffer/)
  })
  it("retry policy and persistence remain owned by CheckRunner", () => {
    const runner = readFileSync(join(root, "apps/worker/src/check-runner.ts"), "utf8")
    expect(runner).toContain("ProviderRegistry")
    expect(runner).toContain("Schedule.recurs(3)")
    expect(runner).toContain("isRetryableProviderError")
    expect(runner).toContain("completeRun: true")
    for (const path of sources(join(root, "packages/providers/src"))) expect(readFileSync(path, "utf8"), path).not.toContain("Effect.retry")
  })
  it("hosted CI and config need no Rust installation or worker path", () => {
    const hosted = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").split("  hosted:")[1]!
    expect(hosted).not.toMatch(/cargo|rust-toolchain|rust-cache|GHOSTPING_WORKER_PATH/)
    expect(readFileSync(join(root, ".env.example"), "utf8")).not.toContain("GHOSTPING_WORKER_PATH")
  })
})

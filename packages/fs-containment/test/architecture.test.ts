// Architecture guard: @openrecord/fs-containment is the only hosted source
// allowed to mutate the filesystem. Elsewhere, fs may be imported only by
// name, only for reads, and only in the files listed below; the mutation-
// capable layers (site adapters, API, worker) may not import fs at all.
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join, relative } from "node:path"

const repo = fileURLToPath(new URL("../../../", import.meta.url))

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist", ".git"].includes(entry.name)) return []
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    // JavaScript shims count too: a .js/.mjs/.cjs file could re-export fs.
    return /\.[cm]?[jt]sx?$/.test(path) && !/\.test\.[cm]?[jt]sx?$/.test(path) ? [path] : []
  })

const FS_MODULE = String.raw`["'](?:node:)?fs(?:/promises)?["']`
const ANY_FS_REFERENCE = new RegExp(FS_MODULE)
const NAMED_IMPORT = new RegExp(String.raw`^\s*import\s*(type\s+)?\{([^}]*)\}\s*from\s*${FS_MODULE}`, "gm")
const READ_ONLY = new Set(["readFile", "readFileSync", "readdir", "readdirSync", "stat", "statSync", "existsSync", "type Stats", "Stats"])

/** Files (repo-relative) that may import read-only fs names. */
const READ_ALLOWED = new Set([
  "packages/db/src/migrate.ts", // reads the migrations directory
  "packages/truth/src/cli.ts", // reads the manifest path the operator passes
])

const CONTAINMENT_SRC = "packages/fs-containment/src/"
const NO_FS_AT_ALL = ["packages/site-operator/src/", "apps/api/src/", "apps/worker/src/"]

// Runtime sources only: packages/*/src, apps/*/src, apps/web/app. Developer
// fixture generators (packages/protocol/scripts) write repository files at
// build time and are not reachable from any request or job.
const RUNTIME = /^(packages\/[^/]+\/src|apps\/[^/]+\/src|apps\/web\/app)\//
const hosted = () =>
  [...sources(join(repo, "apps")), ...sources(join(repo, "packages"))]
    .map((abs) => ({ abs, rel: relative(repo, abs).split("\\").join("/"), text: readFileSync(abs, "utf8") }))
    .filter((f) => RUNTIME.test(f.rel))

describe("filesystem mutation architecture", () => {
  it("only fs-containment references fs outside an explicit read-only allowlist", () => {
    for (const f of hosted()) {
      if (f.rel.startsWith(CONTAINMENT_SRC) || !ANY_FS_REFERENCE.test(f.text)) continue
      expect(READ_ALLOWED.has(f.rel), `${f.rel} imports fs; route filesystem access through @openrecord/fs-containment`).toBe(true)
      // Every fs reference must be a static named import of read-only names:
      // no namespace/default imports, no dynamic import(), no require().
      const references = f.text.match(new RegExp(FS_MODULE, "g"))?.length ?? 0
      const named = [...f.text.matchAll(NAMED_IMPORT)]
      expect(named.length, `${f.rel}: fs referenced other than by a static named import`).toBe(references)
      for (const m of named) {
        for (const name of m[2]!.split(",").map((s) => s.trim().split(/\s+as\s+/)[0]!.trim()).filter(Boolean)) {
          expect(READ_ONLY.has(name), `${f.rel} imports fs.${name}`).toBe(true)
        }
      }
    }
  })

  // Module loading that a static scan cannot follow is forbidden outright in
  // runtime sources (dynamic import() is allowed only with a string literal).
  const LOADER_ESCAPES = [
    /\bcreateRequire\b/,
    /\bgetBuiltinModule\b/,
    /process\.binding\b/,
    /(^|[^.\w])require\s*\(/m,
    /\bimport\s*\(\s*(?!["'][^"']*["']\s*\))/,
  ]

  // Comment-only lines and block comments are prose, not code.
  const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n")

  it("runtime sources never load modules in ways the scan cannot see", () => {
    for (const f of hosted()) {
      for (const re of LOADER_ESCAPES) expect(code(f.text), `${f.rel} matches ${re}`).not.toMatch(re)
    }
  })

  it("site adapters, API and worker never import fs", () => {
    for (const f of hosted()) {
      if (!NO_FS_AT_ALL.some((p) => f.rel.startsWith(p))) continue
      expect(f.text, f.rel).not.toMatch(ANY_FS_REFERENCE)
    }
  })

  it("site adapters write only through the approval-bound mutation path", () => {
    const adapter = readFileSync(join(repo, "packages/site-operator/src/adapter.ts"), "utf8")
    expect(adapter).not.toMatch(/writeContainedFile/)
    expect(adapter).toMatch(/applyApprovedMutation/)
    const mutation = readFileSync(join(repo, "packages/site-operator/src/mutation.ts"), "utf8")
    expect(mutation).toMatch(/expectedBeforeSha256: plan\.beforeSha256/)
  })

  it("the loader guard catches computed and indirect loading", () => {
    const bad = [
      `const r = createRequire(import.meta.url); r("f" + "s")`,
      "process.getBuiltinModule(`f${'s'}`)",
      `const m = await import(name)`,
      "const m = await import(`node:${x}`)",
      `const fs = require("fs")`,
      `process.binding("fs")`,
    ]
    for (const text of bad) expect(LOADER_ESCAPES.some((re) => re.test(text)), text).toBe(true)
    for (const ok of [`const { x } = await import("@openrecord/db")`, `obj.require(1)`]) {
      expect(LOADER_ESCAPES.some((re) => re.test(ok)), ok).toBe(false)
    }
  })

  it("the guard itself detects bypasses", () => {
    const bad = [
      `import { writeFile } from "node:fs/promises"`,
      `import * as fs from "fs"`,
      `import fs from "node:fs"`,
      `const { rm } = await import("node:fs/promises")`,
      `const fs = require("fs")`,
      `import { promises as fs } from "node:fs"`,
    ]
    for (const text of bad) {
      const references = text.match(new RegExp(FS_MODULE, "g"))?.length ?? 0
      const named = [...text.matchAll(NAMED_IMPORT)]
      const onlyReads = named.every((m) => m[2]!.split(",").every((s) => READ_ONLY.has(s.trim().split(/\s+as\s+/)[0]!.trim())))
      expect(references > 0 && named.length === references && onlyReads, text).toBe(false)
    }
  })
})

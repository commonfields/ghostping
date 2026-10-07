// SiteAdapter mechanics: deterministic local mutation + git branch/commit.
// No network, no randomness beyond temp dirs.
import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPatch, removeNoindexFromHtml } from "../src/fixes.js"
import { GitSiteAdapter, LocalFileSiteAdapter, noindexMutationForHtml } from "../src/adapter.js"

const BROKEN = `<!doctype html><html><head><title>T</title>
<meta name="robots" content="noindex, follow">
</head><body><h1>T</h1></body></html>`

describe("removeNoindexFromHtml", () => {
  it("removes only the noindex token, preserving the rest", () => {
    const after = removeNoindexFromHtml(BROKEN)!
    expect(after).not.toContain("noindex")
    expect(after).toContain("follow")
    expect(after).toContain("<h1>T</h1>")
  })

  it("refuses to guess when no robots meta tag exists", () => {
    expect(removeNoindexFromHtml("<html><head><title>T</title></head></html>")).toBeNull()
    expect(removeNoindexFromHtml("<html><head><title>T</title></head><body></body></html>")).toBeNull()
  })

  it("produces a readable before/after patch", () => {
    const m = noindexMutationForHtml("index.html", BROKEN)!
    expect(m.before).toBe(BROKEN)
    expect(m.patch).toContain("--- a/index.html")
    expect(m.patch).toContain("+++ b/index.html")
    expect(buildPatch("index.html", "a", "b")).toContain("-a")
  })
})

describe("LocalFileSiteAdapter", () => {
  it("applies the mutation and verifies the live content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-adapter-"))
    writeFileSync(join(dir, "index.html"), BROKEN)
    const before = (await LocalFileSiteAdapter.inspect({ rootDir: dir, filePath: "index.html" }))!
    const m = noindexMutationForHtml("index.html", before)!
    const prepared = await LocalFileSiteAdapter.prepareMutation({ rootDir: dir, input: { filePath: "index.html", before: m.before, after: m.after, message: "test" } })
    expect(prepared.patch).toContain("noindex")
    await LocalFileSiteAdapter.applyMutation({ rootDir: dir, input: { filePath: "index.html", before: m.before, after: m.after, message: "test" } })
    expect(await LocalFileSiteAdapter.verifyMutation({ rootDir: dir, filePath: "index.html", absent: "noindex" })).toBe(true)
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toContain("noindex")
  })

  it("verification fails honestly when production still contains the marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-adapter-"))
    writeFileSync(join(dir, "index.html"), BROKEN)
    expect(await LocalFileSiteAdapter.verifyMutation({ rootDir: dir, filePath: "index.html", absent: "noindex" })).toBe(false)
  })
})

describe("GitSiteAdapter", () => {
  it("stages the change in a git checkout without committing or merging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-git-"))
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "test@openrecord.test"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "openrecord-test"], { cwd: dir })
    writeFileSync(join(dir, "index.html"), BROKEN)
    execFileSync("git", ["add", "."], { cwd: dir })
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir })
    const mainBefore = execFileSync("git", ["rev-parse", "main"], { cwd: dir }).toString().trim()
    const before = (await GitSiteAdapter.inspect({ rootDir: dir, filePath: "index.html" }))!
    const m = noindexMutationForHtml("index.html", before)!
    const result = await GitSiteAdapter.applyMutation({
      rootDir: dir,
      input: { filePath: "index.html", before: m.before, after: m.after, message: "Remove noindex from https://example.com/" },
      branch: "openrecord/remove-noindex-test",
    })
    expect(result.branch).toBe("openrecord/remove-noindex-test")
    // The adapter never commits: identity is observed later, never invented.
    expect(result.commitSha).toBeNull()
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toContain("noindex")
    const mainAfter = execFileSync("git", ["rev-parse", "main"], { cwd: dir }).toString().trim()
    expect(mainAfter).toBe(mainBefore)
    expect(await GitSiteAdapter.verifyMutation({ rootDir: dir, filePath: "index.html", absent: "noindex" })).toBe(true)
  })

  it("fails closed outside a git checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-nogit-"))
    writeFileSync(join(dir, "index.html"), BROKEN)
    await expect(
      GitSiteAdapter.applyMutation({ rootDir: dir, input: { filePath: "index.html", before: BROKEN, after: "x", message: "m" } }),
    ).rejects.toThrow(/ADAPTER_FAILURE/)
  })
})

// SiteAdapter mechanics: deterministic local mutation + git branch staging,
// all through the containment primitive and the approval binding.
// No network, no randomness beyond temp dirs.
import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPatch, removeNoindexFromHtml } from "../src/fixes.js"
import { GitSiteAdapter, LocalFileSiteAdapter, noindexMutationForHtml, readGitHead } from "../src/adapter.js"

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
  it("prepares, applies the approved change, and verifies the content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-adapter-"))
    writeFileSync(join(dir, "index.html"), BROKEN)
    expect(await LocalFileSiteAdapter.inspect({ rootDir: dir, filePath: "index.html" })).toBe(BROKEN)
    const prepared = await LocalFileSiteAdapter.prepareMutation({ rootDir: dir, targetPath: "index.html", fixKind: "REMOVE_NOINDEX_META" })
    if (!prepared.ok) throw new Error("prepare failed")
    expect(prepared.prepared.plan.patch).toContain("noindex")
    const plan = prepared.prepared.plan
    const applied = await LocalFileSiteAdapter.applyMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan, approvedPatchSha256: plan.patchSha256 })
    expect(applied.ok).toBe(true)
    expect(await LocalFileSiteAdapter.verifyMutation({ rootDir: dir, filePath: "index.html", absent: "noindex" })).toBe(true)
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toContain("noindex")
  })

  it("verification fails honestly when production still contains the marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-adapter-"))
    writeFileSync(join(dir, "index.html"), BROKEN)
    expect(await LocalFileSiteAdapter.verifyMutation({ rootDir: dir, filePath: "index.html", absent: "noindex" })).toBe(false)
  })

  it("never reads or prepares outside the checkout", async () => {
    const base = mkdtempSync(join(tmpdir(), "openrecord-adapter-"))
    const dir = join(base, "site")
    mkdirSync(dir)
    writeFileSync(join(base, "outside.html"), BROKEN)
    symlinkSync(join(base, "outside.html"), join(dir, "link.html"))
    for (const filePath of ["../outside.html", "link.html", "/etc/hosts", "..\\outside.html"]) {
      expect(await LocalFileSiteAdapter.inspect({ rootDir: dir, filePath })).toBeNull()
      const r = await LocalFileSiteAdapter.prepareMutation({ rootDir: dir, targetPath: filePath, fixKind: "REMOVE_NOINDEX_META" })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.failure._tag).toBe("PathRejected")
    }
  })
})

describe("GitSiteAdapter", () => {
  const gitRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-git-"))
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    execFileSync("git", ["config", "user.email", "test@openrecord.test"], { cwd: dir })
    execFileSync("git", ["config", "user.name", "openrecord-test"], { cwd: dir })
    writeFileSync(join(dir, "index.html"), BROKEN)
    execFileSync("git", ["add", "."], { cwd: dir })
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: dir })
    return dir
  }

  it("stages the approved change in a git checkout without committing or merging", async () => {
    const dir = gitRepo()
    const mainBefore = execFileSync("git", ["rev-parse", "main"], { cwd: dir }).toString().trim()
    const prepared = await GitSiteAdapter.prepareMutation({ rootDir: dir, targetPath: "index.html", fixKind: "REMOVE_NOINDEX_META" })
    if (!prepared.ok) throw new Error("prepare failed")
    // The plan records the checkout it was prepared against.
    expect(prepared.prepared.baseRef).toBe(mainBefore)
    const plan = prepared.prepared.plan
    const result = await GitSiteAdapter.applyMutation({
      rootDir: dir,
      fixKind: "REMOVE_NOINDEX_META",
      plan,
      approvedPatchSha256: plan.patchSha256,
      branch: "openrecord/remove-noindex-test",
    })
    if (!result.ok) throw new Error(`apply failed: ${result.failure._tag}`)
    expect(result.result.branch).toBe("openrecord/remove-noindex-test")
    // The adapter never commits: identity is observed later, never invented.
    expect(result.result.commitSha).toBeNull()
    expect(readFileSync(join(dir, "index.html"), "utf8")).not.toContain("noindex")
    const mainAfter = execFileSync("git", ["rev-parse", "main"], { cwd: dir }).toString().trim()
    expect(mainAfter).toBe(mainBefore)
    expect(await GitSiteAdapter.verifyMutation({ rootDir: dir, filePath: "index.html", absent: "noindex" })).toBe(true)
  })

  it("fails closed outside a git checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-nogit-"))
    writeFileSync(join(dir, "index.html"), BROKEN)
    const prepared = await LocalFileSiteAdapter.prepareMutation({ rootDir: dir, targetPath: "index.html", fixKind: "REMOVE_NOINDEX_META" })
    if (!prepared.ok) throw new Error("prepare failed")
    const plan = prepared.prepared.plan
    const r = await GitSiteAdapter.applyMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan, approvedPatchSha256: plan.patchSha256 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure._tag).toBe("ADAPTER_FAILURE")
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(BROKEN)
  })

  it("reads HEAD from loose and packed refs, and refuses unsafe refs", async () => {
    const dir = gitRepo()
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim()
    expect(await readGitHead(dir)).toBe(head)
    execFileSync("git", ["pack-refs", "--all"], { cwd: dir })
    expect(await readGitHead(dir)).toBe(head)
    writeFileSync(join(dir, ".git/HEAD"), "ref: refs/../../../etc/passwd\n")
    expect(await readGitHead(dir)).toBeNull()
  })
})

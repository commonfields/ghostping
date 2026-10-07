// Mutation preconditions: approval binds to exact bytes. Each failure mode
// leaves the source untouched.
import { describe, expect, it } from "vitest"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256Hex, writeContainedFile } from "@openrecord/fs-containment"
import { applyApprovedMutation, patchHashOf, prepareFileMutation, type MutationPlan } from "../src/mutation.js"

const BROKEN = `<html><head><meta name="robots" content="noindex"></head><body>x</body></html>`

const setup = async (): Promise<{ dir: string; plan: MutationPlan }> => {
  const dir = mkdtempSync(join(tmpdir(), "openrecord-mutation-"))
  writeFileSync(join(dir, "index.html"), BROKEN)
  const r = await prepareFileMutation({ rootDir: dir, targetPath: "index.html", fixKind: "REMOVE_NOINDEX_META" })
  if (!r.ok) throw new Error(r.failure._tag)
  return { dir, plan: r.plan }
}

describe("prepareFileMutation", () => {
  it("binds target path, before hash, after hash and patch hash", async () => {
    const { plan } = await setup()
    expect(plan.targetPath).toBe("index.html")
    expect(plan.beforeSha256).toBe(sha256Hex(BROKEN))
    expect(plan.afterSha256).not.toBe(plan.beforeSha256)
    expect(plan.patchSha256).toBe(patchHashOf(plan))
    expect(plan.patch).toContain("-<html><head><meta name=\"robots\" content=\"noindex\">")
  })

  it("refuses unsupported kinds, missing sources and no-op transforms", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-mutation-"))
    writeFileSync(join(dir, "clean.html"), "<html><head></head></html>")
    expect(await prepareFileMutation({ rootDir: dir, targetPath: "clean.html", fixKind: "FIX_CANONICAL" })).toMatchObject({ ok: false, failure: { _tag: "UnsupportedFixKind" } })
    expect(await prepareFileMutation({ rootDir: dir, targetPath: "missing.html", fixKind: "REMOVE_NOINDEX_META" })).toMatchObject({ ok: false, failure: { _tag: "SourceNotFound" } })
    expect(await prepareFileMutation({ rootDir: dir, targetPath: "clean.html", fixKind: "REMOVE_NOINDEX_META" })).toMatchObject({ ok: false, failure: { _tag: "TransformNotApplicable" } })
  })
})

describe("applyApprovedMutation", () => {
  it("applies when every binding holds", async () => {
    const { dir, plan } = await setup()
    const r = await applyApprovedMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan, approvedPatchSha256: plan.patchSha256 })
    expect(r).toEqual({ ok: true, beforeSha256: plan.beforeSha256, afterSha256: plan.afterSha256 })
    expect(sha256Hex(readFileSync(join(dir, "index.html")))).toBe(plan.afterSha256)
  })

  it("stale before hash -> PRECONDITION_FAILED, nothing written", async () => {
    const { dir, plan } = await setup()
    const edited = BROKEN.replace("<body>x", "<body>edited by a human")
    writeFileSync(join(dir, "index.html"), edited)
    const r = await applyApprovedMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan, approvedPatchSha256: plan.patchSha256 })
    expect(r).toMatchObject({ ok: false, failure: { _tag: "PRECONDITION_FAILED", actualSha256: sha256Hex(edited) } })
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(edited)
  })

  it("deleted source -> PRECONDITION_FAILED", async () => {
    const { plan } = await setup()
    const empty = mkdtempSync(join(tmpdir(), "openrecord-mutation-"))
    const r = await applyApprovedMutation({ rootDir: empty, fixKind: "REMOVE_NOINDEX_META", plan, approvedPatchSha256: plan.patchSha256 })
    expect(r).toMatchObject({ ok: false, failure: { _tag: "PRECONDITION_FAILED", actualSha256: null } })
  })

  it("approved hash differs from the prepared patch -> APPROVAL_INVALIDATED, nothing written", async () => {
    const { dir, plan } = await setup()
    const r = await applyApprovedMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan, approvedPatchSha256: sha256Hex("a different, earlier patch") })
    expect(r).toMatchObject({ ok: false, failure: { _tag: "APPROVAL_INVALIDATED" } })
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(BROKEN)
  })

  it("tampered plan (path or after hash edited after approval) -> APPROVAL_INVALIDATED", async () => {
    const { dir, plan } = await setup()
    writeFileSync(join(dir, "other.html"), BROKEN)
    for (const tampered of [{ ...plan, targetPath: "other.html" }, { ...plan, afterSha256: sha256Hex("<html>attacker</html>") }]) {
      const r = await applyApprovedMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan: tampered, approvedPatchSha256: plan.patchSha256 })
      expect(r).toMatchObject({ ok: false, failure: { _tag: "APPROVAL_INVALIDATED" } })
    }
    // Re-hashing the tampered plan does not help: it no longer matches the approval.
    const rehashed = { ...plan, targetPath: "other.html" }
    const r = await applyApprovedMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan: { ...rehashed, patchSha256: patchHashOf(rehashed) }, approvedPatchSha256: plan.patchSha256 })
    expect(r).toMatchObject({ ok: false, failure: { _tag: "APPROVAL_INVALIDATED" } })
    expect(readFileSync(join(dir, "other.html"), "utf8")).toBe(BROKEN)
    expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(BROKEN)
  })

  it("post-write hash mismatch -> MUTATION_FAILED (real read-back of changed bytes)", async () => {
    const { dir, plan } = await setup()
    // A concurrent writer changes the file between our rename and read-back.
    const racing: typeof writeContainedFile = (root, candidate, bytes, options) =>
      writeContainedFile(root, candidate, bytes, {
        ...options,
        onStage: async (s) => {
          if (s === "renamed") writeFileSync(join(dir, "index.html"), "someone else's bytes")
        },
      })
    const r = await applyApprovedMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan, approvedPatchSha256: plan.patchSha256, write: racing })
    expect(r).toMatchObject({ ok: false, failure: { _tag: "MUTATION_FAILED" } })
  })

  it("an edit between the final hash and the rename -> MUTATION_FAILED, never success", async () => {
    const { dir, plan } = await setup()
    const racing: typeof writeContainedFile = (root, candidate, bytes, options) =>
      writeContainedFile(root, candidate, bytes, {
        ...options,
        onStage: async (s) => {
          if (s === "checked") writeFileSync(join(dir, "index.html"), BROKEN.replace("x", "edited in place"))
        },
      })
    const r = await applyApprovedMutation({ rootDir: dir, fixKind: "REMOVE_NOINDEX_META", plan, approvedPatchSha256: plan.patchSha256, write: racing })
    expect(r).toMatchObject({ ok: false, failure: { _tag: "MUTATION_FAILED" } })
  })

  it("repository metadata is never a mutation target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openrecord-mutation-"))
    mkdirSync(join(dir, ".git"))
    writeFileSync(join(dir, ".git", "description.html"), BROKEN)
    for (const targetPath of [".git/description.html", ".GIT/description.html"]) {
      expect(await prepareFileMutation({ rootDir: dir, targetPath, fixKind: "REMOVE_NOINDEX_META" })).toMatchObject({ ok: false, failure: { _tag: "PathRejected", code: "RESERVED_PATH" } })
    }
  })

  it("plan paths are still contained at apply time", async () => {
    const { dir, plan } = await setup()
    const escaped = { ...plan, targetPath: "../index.html" }
    const r = await applyApprovedMutation({ rootDir: join(dir), fixKind: "REMOVE_NOINDEX_META", plan: { ...escaped, patchSha256: patchHashOf(escaped) }, approvedPatchSha256: patchHashOf(escaped) })
    expect(r).toMatchObject({ ok: false, failure: { _tag: "PathRejected", code: "TRAVERSAL" } })
  })
})

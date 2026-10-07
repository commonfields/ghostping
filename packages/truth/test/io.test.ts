// The truth CLI's real working-tree IO (lock, receipts, outputs) through
// the containment primitive, plus apply's read-back check. plan-apply.test.ts
// covers planning semantics with its own helpers; this file exercises the
// production IO module.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ContainmentError } from "@openrecord/fs-containment"
import { applyArtifact, compileProjection, fileIo, parseManifest, readLock, type MaterializationReceiptV1, type ResolvedFact } from "../src/index.js"
import { VALID_MANIFEST_TEXT } from "./manifest-text.js"

const compile = () => {
  const m = parseManifest(VALID_MANIFEST_TEXT)
  const resolved = new Map<string, ResolvedFact>(
    m.facts.map((f) => [f.key, { key: f.key, value: f.value, ref: { kind: "MANIFEST_FACT" as const, key: f.key, manifest_digest: m.digest } }]),
  )
  return { manifest: m, artifact: compileProjection(m, m.projections[0]!.id, resolved) }
}
const ctx = (digest: string, id = "r1") => ({ businessKey: "acme", manifestDigest: digest, actor: { kind: "HUMAN" as const, id: "op" }, now: "2026-10-07T00:00:00.000Z", newId: () => id })

describe("truth CLI IO (production module)", () => {
  it("apply writes the output, lock and receipt through the primitive", async () => {
    const root = mkdtempSync(join(tmpdir(), "truth-io-"))
    const { manifest, artifact } = compile()
    const r = await applyArtifact(artifact, ctx(manifest.digest), fileIo(root))
    expect(r.receipt?.action).toBe("CREATED")
    expect(readFileSync(join(root, artifact.relative_output_path), "utf8")).toBe(artifact.canonical_bytes)
    expect((await readLock(root)).projections[artifact.projection_id]?.digest).toBe(artifact.digest_sha256)
    expect(existsSync(join(root, ".openrecord/receipts/r1.json"))).toBe(true)
  })

  it("refuses a symlinked lock file or metadata directory; outside untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "truth-io-"))
    const outside = mkdtempSync(join(tmpdir(), "truth-io-outside-"))
    writeFileSync(join(outside, "lock.json"), `{"projections":{}}`)
    mkdirSync(join(root, ".openrecord"))
    symlinkSync(join(outside, "lock.json"), join(root, ".openrecord/projections.lock.json"))
    await expect(readLock(root)).rejects.toBeInstanceOf(ContainmentError)
    await expect(fileIo(root).writeLock({ projections: {} })).rejects.toBeInstanceOf(ContainmentError)
    const root2 = mkdtempSync(join(tmpdir(), "truth-io-"))
    symlinkSync(outside, join(root2, ".openrecord"))
    await expect(fileIo(root2).writeLock({ projections: {} })).rejects.toBeInstanceOf(ContainmentError)
    expect(readdirSync(outside)).toEqual(["lock.json"])
    expect(readFileSync(join(outside, "lock.json"), "utf8")).toBe(`{"projections":{}}`)
  })

  it("receipt ids cannot traverse and receipts are never overwritten", async () => {
    const root = mkdtempSync(join(tmpdir(), "truth-io-"))
    const io = fileIo(root)
    const receipt = (id: string) => ({ id }) as unknown as MaterializationReceiptV1
    await expect(io.appendReceipt(receipt("../../escape"))).rejects.toBeInstanceOf(ContainmentError)
    await io.appendReceipt(receipt("r1"))
    await expect(io.appendReceipt(receipt("r1"))).rejects.toThrow(/PreconditionFailed/)
  })

  it("a read-back that differs from the artifact digest fails before lock or receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "truth-io-"))
    const { manifest, artifact } = compile()
    const io = {
      ...fileIo(root),
      onWriteStage: async (s: string) => {
        if (s === "renamed") writeFileSync(join(root, artifact.relative_output_path), "tampered")
      },
    }
    await expect(applyArtifact(artifact, ctx(manifest.digest), io)).rejects.toThrow(/ReadbackMismatch/)
    expect(existsSync(join(root, ".openrecord/projections.lock.json"))).toBe(false)
    expect(existsSync(join(root, ".openrecord/receipts"))).toBe(false)
  })
})

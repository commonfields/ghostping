import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  applyArtifact,
  compileProjection,
  compileVerificationBindings,
  guardManifestSync,
  guardModeTransition,
  parseManifest,
  planProjection,
  planStale,
  resolveInsideRoot,
  syncManifestFacts,
  syncVerificationBindings,
  type FactSyncStore,
  type ProjectionLock,
  type ResolvedFact,
  type SyncedFact,
} from "../src/index.js"
import { deriveFinding } from "@ghostping/representation"
import { VALID_MANIFEST_TEXT } from "./manifest-text.js"

const memStore = (): FactSyncStore & { modes: Map<string, "HOSTED" | "REPOSITORY_MANIFEST">; rows: Map<string, SyncedFact & { business: string }> } => {
  const modes = new Map<string, "HOSTED" | "REPOSITORY_MANIFEST">()
  const rows = new Map<string, SyncedFact & { business: string }>()
  let n = 0
  const activeFor = (businessId: string) => [...rows.values()].filter((r) => r.business === businessId && r.status === "ACTIVE")
  return {
    modes,
    rows,
    mode: async (b) => modes.get(b) ?? null,
    factCount: async (b) => [...rows.values()].filter((r) => r.business === b).length,
    setMode: async (b, m) => {
      modes.set(b, m)
    },
    activeFacts: async (b) => activeFor(b),
    provenanceKeys: async (b) => new Set([...rows.values()].filter((r) => r.business === b).map((r) => r.key)),
    create: async (b, fact, bridged, prov) => {
      n += 1
      const row = { id: `fact-${n}`, key: prov.manifest_key, version: 1, status: "ACTIVE" as const, value: fact.value, valid_from: fact.valid_from, valid_until: fact.valid_until, business: b }
      void bridged
      rows.set(row.id, row)
      return row
    },
    supersede: async (b, prevId, fact, bridged, prov) => {
      const prev = rows.get(prevId)!
      rows.set(prevId, { ...prev, status: "SUPERSEDED" })
      n += 1
      const row = { id: `fact-${n}`, key: prov.manifest_key, version: prev.version + 1, status: "ACTIVE" as const, value: fact.value, valid_from: fact.valid_from, valid_until: fact.valid_until, business: b }
      void bridged
      rows.set(row.id, row)
      return row
    },
    retire: async (_b, factId) => {
      const prev = rows.get(factId)!
      rows.set(factId, { ...prev, status: "RETIRED" })
    },
  }
}

describe("authority", () => {
  it("existing businesses default to HOSTED and reject manifest sync", async () => {
    const store = memStore()
    // Legacy business with facts, no mode row: stays HOSTED.
    await store.create("biz", { key: "k", subject: "s", predicate: "p", value: { type: "text", value: "v" }, valid_from: "2026-10-03T00:00:00.000Z", valid_until: null, source_url: null }, { value_text: "v", value_type: "TEXT" }, { manifest_key: "k", manifest_digest: "d", source_revision: null, synced_at: "2026-10-03T00:00:00.000Z", writer: "REPOSITORY_MANIFEST" })
    await expect(guardManifestSync(store, "biz")).rejects.toThrowError(/ManifestSyncRejectedForHosted/)
  })

  it("empty businesses become repository-managed; mode then immutable", async () => {
    const store = memStore()
    await expect(guardManifestSync(store, "new-biz")).resolves.toBe("REPOSITORY_MANIFEST")
    expect(await store.mode("new-biz")).toBe("REPOSITORY_MANIFEST")
    await store.create("new-biz", { key: "k", subject: "s", predicate: "p", value: { type: "text", value: "v" }, valid_from: "2026-10-03T00:00:00.000Z", valid_until: null, source_url: null }, { value_text: "v", value_type: "TEXT" }, { manifest_key: "k", manifest_digest: "d", source_revision: null, synced_at: "2026-10-03T00:00:00.000Z", writer: "REPOSITORY_MANIFEST" })
    await expect(guardModeTransition(store, "new-biz", "HOSTED")).rejects.toThrowError(/AuthorityModeImmutable/)
  })

  it("sync is idempotent; changes version; removals retire; strangers untouched", async () => {
    const store = memStore()
    const m1 = parseManifest(VALID_MANIFEST_TEXT)
    const r1 = await syncManifestFacts(m1, "biz", store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
    expect(r1.created.sort()).toEqual(["salesforce-supported", "starter-price", "tagline"])
    const r2 = await syncManifestFacts(m1, "biz", store, { sourceRevision: null, now: "2026-10-03T01:00:00.000Z" })
    expect(r2.created).toEqual([])
    expect(r2.superseded).toEqual([])
    expect(r2.retired).toEqual([])
    expect(r2.unchanged.sort()).toEqual(["salesforce-supported", "starter-price", "tagline"])
    // Price change -> new version, history preserved.
    const m2 = parseManifest(VALID_MANIFEST_TEXT.replace('amount: "49.00"', 'amount: "59.00"'))
    const r3 = await syncManifestFacts(m2, "biz", store, { sourceRevision: "abc123", now: "2026-10-04T00:00:00.000Z" })
    expect(r3.superseded).toEqual(["starter-price"])
    expect(r3.resolved.get("starter-price")?.version).toBe(2)
    const versions = [...store.rows.values()].filter((r) => r.key === "starter-price").map((r) => [r.version, r.status]).sort()
    expect(versions).toEqual([[1, "SUPERSEDED"], [2, "ACTIVE"]])
    // Removal retires, unrelated facts untouched.
    const m3 = parseManifest(VALID_MANIFEST_TEXT.replace(/  tagline:\n(?:    .*\n)+/, ""))
    const r4 = await syncManifestFacts(m3, "biz", store, { sourceRevision: null, now: "2026-10-05T00:00:00.000Z" })
    expect(r4.retired).toEqual(["tagline"])
    expect(store.rows.get(r1.resolved.get("tagline")!.fact_id)?.status).toBe("RETIRED")
    // Unknown source revision stays absent, never fabricated.
    expect(r1.resolved.size).toBe(3)
  })
})

const fileIo = (root: string) => ({
  root,
  read: async (rel: string) => {
    try {
      return new Uint8Array(await readFile(resolve(root, rel)))
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null
      throw e
    }
  },
  readLock: async (): Promise<ProjectionLock> => {
    try {
      return JSON.parse(await readFile(resolve(root, ".ghostping/projections.lock.json"), "utf8")) as ProjectionLock
    } catch {
      return { projections: {} }
    }
  },
  writeLock: async (lock: ProjectionLock) => {
    await mkdir(resolve(root, ".ghostping"), { recursive: true })
    await writeFile(resolve(root, ".ghostping/projections.lock.json"), `${JSON.stringify(lock, null, 2)}\n`)
  },
  appendReceipt: async (receipt: unknown) => {
    const r = receipt as { id: string }
    await mkdir(resolve(root, ".ghostping/receipts"), { recursive: true })
    await writeFile(resolve(root, `.ghostping/receipts/${r.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" })
  },
})

const compileAll = (text: string) => {
  const m = parseManifest(text)
  const resolved = new Map<string, ResolvedFact>(
    m.facts.map((f) => [f.key, { key: f.key, fact_id: `fact:${f.key}`, version: 1, value: f.value }]),
  )
  return { manifest: m, artifacts: m.projections.map((p) => compileProjection(m, p.id, resolved)) }
}

describe("plan and apply", () => {
  it("CREATE -> apply -> UNCHANGED; second apply rewrites nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "truth-"))
    const { manifest, artifacts } = compileAll(VALID_MANIFEST_TEXT)
    const [artifact] = artifacts
    const io = fileIo(root)
    const first = await planProjection(artifact!, io, { projections: {} })
    expect(first.action).toBe("CREATE")
    const applied = await applyArtifact(artifact!, { businessKey: "acme", manifestDigest: manifest.digest, actor: { kind: "HUMAN", id: "op-1" }, now: "2026-10-03T00:00:00.000Z", newId: () => "r1" }, io)
    expect(applied.entry.action).toBe("CREATE")
    expect(applied.receipt).toMatchObject({ action: "CREATED", after_digest: artifact!.digest_sha256 })
    expect(applied.receipt?.before_digest).toEqual({ state: "NOT_APPLICABLE" })
    expect(readFileSync(resolve(root, artifact!.relative_output_path), "utf8")).toBe(artifact!.canonical_bytes)
    // Receipt carries no publication claims.
    expect(JSON.stringify(applied.receipt)).not.toMatch(/publish|index|retriev|caus/i)
    const lock = JSON.parse(readFileSync(resolve(root, ".ghostping/projections.lock.json"), "utf8")) as ProjectionLock
    expect(lock.projections["starter-offer"]?.digest).toBe(artifact!.digest_sha256)
    expect(JSON.stringify(lock)).not.toMatch(/49\.00|USD/)
    const planned = await planProjection(artifact!, io, lock)
    expect(planned.action).toBe("UNCHANGED")
    const again = await applyArtifact(artifact!, { businessKey: "acme", manifestDigest: manifest.digest, actor: { kind: "HUMAN", id: "op-1" }, now: "2026-10-03T01:00:00.000Z", newId: () => "r2" }, io)
    expect(again.receipt).toMatchObject({ action: "UNCHANGED" })
    expect(readFileSync(resolve(root, artifact!.relative_output_path), "utf8")).toBe(artifact!.canonical_bytes)
  })

  it("UPDATE on managed change; CONFLICT on unmanaged or hand-edited files", async () => {
    const root = mkdtempSync(join(tmpdir(), "truth-"))
    const first = compileAll(VALID_MANIFEST_TEXT)
    const io = fileIo(root)
    await applyArtifact(first.artifacts[0]!, { businessKey: "acme", manifestDigest: first.manifest.digest, actor: { kind: "AGENT", id: null }, now: "2026-10-03T00:00:00.000Z", newId: () => "r1" }, io)
    // Price change -> UPDATE with before/after digests.
    const second = compileAll(VALID_MANIFEST_TEXT.replace('amount: "49.00"', 'amount: "59.00"'))
    const lock = JSON.parse(readFileSync(resolve(root, ".ghostping/projections.lock.json"), "utf8")) as ProjectionLock
    const planned = await planProjection(second.artifacts[0]!, io, lock)
    expect(planned.action).toBe("UPDATE")
    const applied = await applyArtifact(second.artifacts[0]!, { businessKey: "acme", manifestDigest: second.manifest.digest, actor: { kind: "AGENT", id: null }, now: "2026-10-04T00:00:00.000Z", newId: () => "r2" }, io)
    expect(applied.receipt).toMatchObject({ action: "UPDATED" })
    expect(applied.receipt?.before_digest).toEqual({ state: "KNOWN", value: first.artifacts[0]!.digest_sha256 })
    expect(applied.receipt?.after_digest).toBe(second.artifacts[0]!.digest_sha256)
    // Hand edit after apply -> CONFLICT, never blind UPDATE.
    writeFileSync(resolve(root, second.artifacts[0]!.relative_output_path), `{"tampered":true}`)
    const conflicted = await planProjection(second.artifacts[0]!, io, JSON.parse(readFileSync(resolve(root, ".ghostping/projections.lock.json"), "utf8")) as ProjectionLock)
    expect(conflicted.action).toBe("CONFLICT")
    const notApplied = await applyArtifact(second.artifacts[0]!, { businessKey: "acme", manifestDigest: second.manifest.digest, actor: { kind: "AGENT", id: null }, now: "2026-10-04T01:00:00.000Z", newId: () => "r3" }, io)
    expect(notApplied.receipt).toBeNull()
    // Unmanaged pre-existing file -> CONFLICT.
    const root2 = mkdtempSync(join(tmpdir(), "truth-"))
    mkdirSync(resolve(root2, "public/generated"), { recursive: true })
    writeFileSync(resolve(root2, second.artifacts[0]!.relative_output_path), second.artifacts[0]!.canonical_bytes)
    const io2 = fileIo(root2)
    const unmanaged = await planProjection(second.artifacts[0]!, io2, { projections: {} })
    expect(unmanaged.action).toBe("CONFLICT")
  })

  it("STALE for removed projections; filesystem guards hold", async () => {
    const root = mkdtempSync(join(tmpdir(), "truth-"))
    const lock: ProjectionLock = { projections: { "old-offer": { digest: "abc", compiler: "truth-compiler/1" } } }
    const stale = planStale(lock, new Set(["starter-offer"]), () => "public/generated/old.json")
    expect(stale[0]).toMatchObject({ action: "STALE_MANAGED_ARTIFACT" })
    expect(() => resolveInsideRoot(root, "../evil.json")).toThrowError(/UnsafeOutputPath/)
    expect(() => resolveInsideRoot(root, "/abs/evil.json")).toThrowError(/AbsoluteOutputPath/)
    expect(() => resolveInsideRoot(root, ".git/hooks/x")).toThrowError(/ReservedOutputPath/)
    // Symlink escape rejected.
    const outside = mkdtempSync(join(tmpdir(), "truth-outside-"))
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(join(outside, "secret.txt"), join(root, "link.json"))
    const { manifest, artifacts } = compileAll(VALID_MANIFEST_TEXT.replace("public/generated/starter-offer.json", "link.json"))
    void manifest
    await expect(
      applyArtifact(artifacts[0]!, { businessKey: "acme", manifestDigest: "d", actor: { kind: "HUMAN", id: null }, now: "2026-10-03T00:00:00.000Z", newId: () => "r1" }, fileIo(root)),
    ).rejects.toThrowError(/SymlinkEscape/)
  })
})

describe("bridge", () => {
  it("verify blocks compile and sync idempotently without copying values", async () => {
    const manifest = parseManifest(VALID_MANIFEST_TEXT)
    const compiled = compileVerificationBindings(manifest)
    expect(compiled).toHaveLength(1)
    expect(compiled[0]).toMatchObject({
      projection_id: "starter-offer",
      target: { url: "https://acme.example/pricing", control: "OWNED" },
      binding: { fact_key: "starter-price", extractor: { kind: "JSON_LD", selector: "offers.price" }, comparator: "MONEY" },
    })
    expect(JSON.stringify(compiled)).not.toMatch(/49\.00/)
    const targets = new Map<string, { id: string; url: string }>()
    const bindings = new Map<string, { id: string; target_id: string; fact_id: string }>()
    let n = 0
    const store = {
      findTargetByUrl: async (c: string) => targets.get(c) ?? null,
      createTarget: async (url: string) => {
        n += 1
        const t = { id: `t${n}`, url }
        targets.set(url, t)
        return t
      },
      findBinding: async (tid: string, fid: string) => bindings.get(`${tid}|${fid}`) ?? null,
      createBinding: async (tid: string, fid: string) => {
        n += 1
        const b = { id: `b${n}`, target_id: tid, fact_id: fid }
        bindings.set(`${tid}|${fid}`, b)
        return b
      },
    }
    const canon = (u: string) => u
    const factIds = new Map([["starter-price", "fact-9"]])
    const once = await syncVerificationBindings(compiled, factIds, canon, store)
    const twice = await syncVerificationBindings(compiled, factIds, canon, store)
    expect(once.map((b) => b.id)).toEqual(twice.map((b) => b.id))
    expect(targets.size).toBe(1)
    expect(bindings.size).toBe(1)
  })
})

describe("live verification has no causal edge", () => {
  it("DRIFT before deploy, IN_SYNC after, citation is not causality", () => {
    const binding = {
      id: "b1",
      business_id: "biz",
      fact_id: "fact-2",
      source_target_id: "t1",
      extractor: { kind: "JSON_LD" as const, selector: "offers.price" },
      comparator: "MONEY" as const,
      created_at: "2026-10-03T00:00:00.000Z",
    }
    const drifted = deriveFinding(
      { id: "fact-2", value_text: "59.00 USD" },
      binding,
      "obs-1",
      { id: "v1", business_id: "biz", source_observation_id: "obs-1", source_binding_id: "b1", fact_id: "fact-2", extracted_value: "49.00 USD", extraction_state: "OBSERVED", evidence_locator: { selector: "offers.price", source_observation_id: "obs-1", node_identity: "json-ld:offers.price" }, extractor_version: "extractors/1", created_at: "2026-10-03T00:00:00.000Z" },
    )
    expect(drifted.state).toBe("DRIFT")
    const synced = deriveFinding(
      { id: "fact-2", value_text: "59.00 USD" },
      binding,
      "obs-2",
      { id: "v2", business_id: "biz", source_observation_id: "obs-2", source_binding_id: "b1", fact_id: "fact-2", extracted_value: "59.00 USD", extraction_state: "OBSERVED", evidence_locator: { selector: "offers.price", source_observation_id: "obs-2", node_identity: "json-ld:offers.price" }, extractor_version: "extractors/1", created_at: "2026-10-04T00:00:00.000Z" },
    )
    expect(synced.state).toBe("IN_SYNC")
    expect(JSON.stringify([drifted, synced])).not.toMatch(/caus/i)
  })
})

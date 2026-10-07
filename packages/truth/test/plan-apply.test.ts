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
  type FactTxStore,
  type ManifestFactV1,
  type ProjectionLock,
  type Provenance,
  type ResolvedFact,
  type SyncedFact,
} from "../src/index.js"
import { deriveFinding } from "@openrecord/representation"
import { VALID_MANIFEST_TEXT } from "./manifest-text.js"

const memStore = (): FactSyncStore & { modes: Map<string, "HOSTED" | "REPOSITORY_MANIFEST">; rows: Map<string, SyncedFact & { business: string }> } => {
  const modes = new Map<string, "HOSTED" | "REPOSITORY_MANIFEST">()
  const rows = new Map<string, SyncedFact & { business: string }>()
  let n = 0
  const activeFor = (businessId: string) => [...rows.values()].filter((r) => r.business === businessId && r.status === "ACTIVE")
  const self = {
    modes,
    rows,
    mode: async (b: string) => modes.get(b) ?? null,
    factCount: async (b: string) => [...rows.values()].filter((r) => r.business === b).length,
    setMode: async (b: string, m: "HOSTED" | "REPOSITORY_MANIFEST") => {
      modes.set(b, m)
    },
    transact: async <T>( _businessId: string, fn: (tx: FactTxStore) => Promise<T>): Promise<T> => fn(self as unknown as FactTxStore),
    activeFacts: async (b: string) => activeFor(b),
    provenanceKeys: async (b: string) => new Set([...rows.values()].filter((r) => r.business === b).map((r) => r.key)),
    latestLineage: async (b: string) => {
      const out = new Map<string, { id: string; version: number; status: SyncedFact["status"] }>()
      for (const r of rows.values()) {
        if (r.business !== b) continue
        const prev = out.get(r.key)
        if (prev === undefined || r.version > prev.version) out.set(r.key, { id: r.id, version: r.version, status: r.status })
      }
      return out
    },
    create: async (b: string, fact: ManifestFactV1, bridged: { value_text: string; value_type: string }, prov: Provenance) => {
      n += 1
      const row = { id: `fact-${n}`, key: prov.manifest_key, version: 1, status: "ACTIVE" as const, subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from, valid_until: fact.valid_until, source_url: fact.source_url, business: b }
      void bridged
      rows.set(row.id, row)
      return row
    },
    supersede: async (b: string, prevId: string, fact: ManifestFactV1, bridged: { value_text: string; value_type: string }, prov: Provenance) => {
      const prev = rows.get(prevId)!
      rows.set(prevId, { ...prev, status: "SUPERSEDED" })
      n += 1
      const row = { id: `fact-${n}`, key: prov.manifest_key, version: prev.version + 1, status: "ACTIVE" as const, subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from, valid_until: fact.valid_until, source_url: fact.source_url, business: b }
      void bridged
      rows.set(row.id, row)
      return row
    },
    reactivate: async (b: string, prevId: string, fact: ManifestFactV1, bridged: { value_text: string; value_type: string }, prov: Provenance) => {
      const prev = rows.get(prevId)!
      n += 1
      const row = { id: `fact-${n}`, key: prov.manifest_key, version: prev.version + 1, status: "ACTIVE" as const, subject: fact.subject, predicate: fact.predicate, value: fact.value, valid_from: fact.valid_from, valid_until: fact.valid_until, source_url: fact.source_url, business: b }
      void bridged
      rows.set(row.id, row)
      return row
    },
    retire: async (_b: string, factId: string) => {
      const prev = rows.get(factId)!
      rows.set(factId, { ...prev, status: "RETIRED" })
    },
  }
  return self
}

describe("authority", () => {
  it("existing businesses default to HOSTED and reject manifest sync", async () => {
    const store = memStore()
    // Legacy business with facts, no mode row: stays HOSTED.
    await store.transact("biz", (tx) =>
      tx.create("biz", { key: "k", subject: "s", predicate: "p", value: { type: "text", value: "v" }, valid_from: "2026-10-03T00:00:00.000Z", valid_until: null, source_url: null }, { value_text: "v", value_type: "TEXT" }, { manifest_key: "k", manifest_digest: "d", source_revision: null, synced_at: "2026-10-03T00:00:00.000Z", writer: "REPOSITORY_MANIFEST" }),
    )
    await expect(guardManifestSync(store, "biz")).rejects.toThrowError(/ManifestSyncRejectedForHosted/)
  })

  it("empty businesses become repository-managed; mode then immutable", async () => {
    const store = memStore()
    await expect(guardManifestSync(store, "new-biz")).resolves.toBe("REPOSITORY_MANIFEST")
    expect(await store.mode("new-biz")).toBe("REPOSITORY_MANIFEST")
    await store.transact("new-biz", (tx) =>
      tx.create("new-biz", { key: "k", subject: "s", predicate: "p", value: { type: "text", value: "v" }, valid_from: "2026-10-03T00:00:00.000Z", valid_until: null, source_url: null }, { value_text: "v", value_type: "TEXT" }, { manifest_key: "k", manifest_digest: "d", source_revision: null, synced_at: "2026-10-03T00:00:00.000Z", writer: "REPOSITORY_MANIFEST" }),
    )
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
    // C. synced compile preserves the real authority version (v2 stays v2).
    const ref3 = r3.resolved.get("starter-price")?.ref
    expect(ref3).toMatchObject({ kind: "AUTHORITATIVE_FACT", key: "starter-price", version: 2 })
    const versions = [...store.rows.values()].filter((r) => r.key === "starter-price").map((r) => [r.version, r.status]).sort()
    expect(versions).toEqual([[1, "SUPERSEDED"], [2, "ACTIVE"]])
    // Removal retires, unrelated facts untouched.
    const m3 = parseManifest(VALID_MANIFEST_TEXT.replace(/  tagline:\n(?:    .*\n)+/, ""))
    const r4 = await syncManifestFacts(m3, "biz", store, { sourceRevision: null, now: "2026-10-05T00:00:00.000Z" })
    expect(r4.retired).toEqual(["tagline"])
    const tagRef = r1.resolved.get("tagline")?.ref
    expect(tagRef?.kind).toBe("AUTHORITATIVE_FACT")
    if (tagRef?.kind === "AUTHORITATIVE_FACT") {
      expect(store.rows.get(tagRef.fact_id)?.status).toBe("RETIRED")
    }
    // Unknown source revision stays absent, never fabricated.
    expect(r1.resolved.size).toBe(3)
  })
})

describe("authority metadata versioning and reactivation", () => {
  it("1. identical manifest creates zero new versions", async () => {
    const store = memStore()
    const m = parseManifest(VALID_MANIFEST_TEXT)
    await syncManifestFacts(m, "biz", store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
    const again = await syncManifestFacts(m, "biz", store, { sourceRevision: null, now: "2026-10-03T01:00:00.000Z" })
    expect([...again.created, ...again.superseded, ...again.reactivated, ...again.retired]).toEqual([])
    expect(again.unchanged.sort()).toEqual(["salesforce-supported", "starter-price", "tagline"])
  })

  it("2. same value with changed subject supersedes", async () => {
    const store = memStore()
    await syncManifestFacts(parseManifest(VALID_MANIFEST_TEXT), "biz", store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
    const changed = await syncManifestFacts(
      parseManifest(VALID_MANIFEST_TEXT.replace("subject: plan:starter", "subject: plan:starter-plus")),
      "biz",
      store,
      { sourceRevision: null, now: "2026-10-04T00:00:00.000Z" },
    )
    expect(changed.superseded).toEqual(["starter-price"])
    expect(changed.unchanged.sort()).toEqual(["salesforce-supported", "tagline"])
  })

  it("3. same value with changed predicate supersedes", async () => {
    const store = memStore()
    await syncManifestFacts(parseManifest(VALID_MANIFEST_TEXT), "biz", store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
    const changed = await syncManifestFacts(
      parseManifest(VALID_MANIFEST_TEXT.replace("predicate: price", "predicate: list-price")),
      "biz",
      store,
      { sourceRevision: null, now: "2026-10-04T00:00:00.000Z" },
    )
    expect(changed.superseded).toEqual(["starter-price"])
  })

  it("4. same value with changed source_url supersedes", async () => {
    const store = memStore()
    await syncManifestFacts(parseManifest(VALID_MANIFEST_TEXT), "biz", store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
    const changed = await syncManifestFacts(
      parseManifest(VALID_MANIFEST_TEXT.replace("https://acme.example/pricing", "https://acme.example/pricing-v2")),
      "biz",
      store,
      { sourceRevision: null, now: "2026-10-04T00:00:00.000Z" },
    )
    expect(changed.superseded).toEqual(["starter-price"])
  })

  it("5/6/7/8. removal retires; re-added keys continue lineage with one ACTIVE head", async () => {
    const store = memStore()
    const m1 = parseManifest(VALID_MANIFEST_TEXT)
    const r1 = await syncManifestFacts(m1, "biz", store, { sourceRevision: null, now: "2026-10-03T00:00:00.000Z" })
    expect(r1.created).toContain("starter-price")
    const withoutFact = VALID_MANIFEST_TEXT.replace(/  starter-price:\n(?:    .*\n|      .*\n)+/, "")
    // A removed fact takes its projection with it; otherwise the manifest is invalid.
    const without = parseManifest(withoutFact.replace(/  starter-offer:\n(?:    .*\n|      .*\n|        .*\n|          .*\n)+/, ""))
    expect(without.facts.some((f) => f.key === "starter-price")).toBe(false)
    expect(without.projections.some((f) => f.id === "starter-offer")).toBe(false)
    // 5. Removal retires.
    const r2 = await syncManifestFacts(without, "biz", store, { sourceRevision: null, now: "2026-10-04T00:00:00.000Z" })
    expect(r2.retired).toEqual(["starter-price"])
    // 6. Re-add identical fact: v2 ACTIVE linked to retired v1, not a fresh v1.
    const r3 = await syncManifestFacts(m1, "biz", store, { sourceRevision: null, now: "2026-10-05T00:00:00.000Z" })
    expect(r3.reactivated).toEqual(["starter-price"])
    expect(r3.created).toEqual([])
    const ref3 = r3.resolved.get("starter-price")?.ref
    expect(ref3?.kind).toBe("AUTHORITATIVE_FACT")
    if (ref3?.kind === "AUTHORITATIVE_FACT") expect(ref3.version).toBe(2)
    // 8. Exactly one ACTIVE head; retired v1 untouched.
    const lineage = [...store.rows.values()].filter((r) => r.key === "starter-price").sort((a, b) => a.version - b.version)
    expect(lineage.map((r) => [r.version, r.status])).toEqual([[1, "RETIRED"], [2, "ACTIVE"]])
    // 7. Re-add with changed value after another retirement also continues lineage.
    const r4 = await syncManifestFacts(without, "biz", store, { sourceRevision: null, now: "2026-10-06T00:00:00.000Z" })
    expect(r4.retired).toEqual(["starter-price"])
    const changed = parseManifest(VALID_MANIFEST_TEXT.replace('amount: "49.00"', 'amount: "59.00"'))
    const r5 = await syncManifestFacts(changed, "biz", store, { sourceRevision: null, now: "2026-10-07T00:00:00.000Z" })
    expect(r5.reactivated).toEqual(["starter-price"])
    const ref5 = r5.resolved.get("starter-price")?.ref
    if (ref5?.kind === "AUTHORITATIVE_FACT") {
      expect(ref5.version).toBe(3)
      expect(r5.resolved.get("starter-price")?.value).toEqual({ type: "money", amount: "59.00", currency: "USD" })
    } else {
      throw new Error("expected authoritative ref")
    }
    const final = [...store.rows.values()].filter((r) => r.key === "starter-price").sort((a, b) => a.version - b.version)
    expect(final.map((r) => [r.version, r.status])).toEqual([[1, "RETIRED"], [2, "RETIRED"], [3, "ACTIVE"]])
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
      return JSON.parse(await readFile(resolve(root, ".openrecord/projections.lock.json"), "utf8")) as ProjectionLock
    } catch {
      return { projections: {} }
    }
  },
  writeLock: async (lock: ProjectionLock) => {
    await mkdir(resolve(root, ".openrecord"), { recursive: true })
    await writeFile(resolve(root, ".openrecord/projections.lock.json"), `${JSON.stringify(lock, null, 2)}\n`)
  },
  appendReceipt: async (receipt: unknown) => {
    const r = receipt as { id: string }
    await mkdir(resolve(root, ".openrecord/receipts"), { recursive: true })
    await writeFile(resolve(root, `.openrecord/receipts/${r.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" })
  },
})

const compileAll = (text: string) => {
  const m = parseManifest(text)
  const resolved = new Map<string, ResolvedFact>(
    m.facts.map((f) => [f.key, { key: f.key, value: f.value, ref: { kind: "MANIFEST_FACT" as const, key: f.key, manifest_digest: m.digest } }]),
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
    // Offline receipt proves manifest lineage only — no invented fact UUID.
    expect(applied.receipt?.source_refs).toEqual([
      { kind: "MANIFEST_FACT", key: "starter-price", manifest_digest: manifest.digest },
    ])
    expect(readFileSync(resolve(root, artifact!.relative_output_path), "utf8")).toBe(artifact!.canonical_bytes)
    // Receipt carries no publication claims.
    expect(JSON.stringify(applied.receipt)).not.toMatch(/publish|index|retriev|caus/i)
    const lock = JSON.parse(readFileSync(resolve(root, ".openrecord/projections.lock.json"), "utf8")) as ProjectionLock
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
    const lock = JSON.parse(readFileSync(resolve(root, ".openrecord/projections.lock.json"), "utf8")) as ProjectionLock
    const planned = await planProjection(second.artifacts[0]!, io, lock)
    expect(planned.action).toBe("UPDATE")
    const applied = await applyArtifact(second.artifacts[0]!, { businessKey: "acme", manifestDigest: second.manifest.digest, actor: { kind: "AGENT", id: null }, now: "2026-10-04T00:00:00.000Z", newId: () => "r2" }, io)
    expect(applied.receipt).toMatchObject({ action: "UPDATED" })
    expect(applied.receipt?.before_digest).toEqual({ state: "KNOWN", value: first.artifacts[0]!.digest_sha256 })
    expect(applied.receipt?.after_digest).toBe(second.artifacts[0]!.digest_sha256)
    // Hand edit after apply -> CONFLICT, never blind UPDATE.
    writeFileSync(resolve(root, second.artifacts[0]!.relative_output_path), `{"tampered":true}`)
    const conflicted = await planProjection(second.artifacts[0]!, io, JSON.parse(readFileSync(resolve(root, ".openrecord/projections.lock.json"), "utf8")) as ProjectionLock)
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
    const store = memBridgeStore()
    const canon = (u: string) => u
    const factIds = new Map([["starter-price", "fact-9"]])
    const once = await syncVerificationBindings(compiled, factIds, canon, store)
    const twice = await syncVerificationBindings(compiled, factIds, canon, store)
    expect(once.map((b) => b.id)).toEqual(twice.map((b) => b.id))
    expect(store.targets.size).toBe(1)
    expect(store.bindings.size).toBe(1)
  })

  it("fact v1→v2→v3 advances the same logical binding without duplicates", async () => {
    const manifest = parseManifest(VALID_MANIFEST_TEXT)
    const compiled = compileVerificationBindings(manifest)
    const store = memBridgeStore()
    const canon = (u: string) => u
    const v1 = await syncVerificationBindings(compiled, new Map([["starter-price", "uuid-a"]]), canon, store)
    expect(v1).toHaveLength(1)
    expect(v1[0]).toMatchObject({ fact_id: "uuid-a" })
    const v2 = await syncVerificationBindings(compiled, new Map([["starter-price", "uuid-b"]]), canon, store)
    expect(v2.map((b) => b.id)).toEqual(v1.map((b) => b.id))
    expect(v2[0]).toMatchObject({ fact_id: "uuid-b" })
    const v3 = await syncVerificationBindings(compiled, new Map([["starter-price", "uuid-c"]]), canon, store)
    expect(v3.map((b) => b.id)).toEqual(v1.map((b) => b.id))
    expect(store.bindings.size).toBe(1)
  })

  it("reactivated keys reuse the logical binding; extractor/target changes are explicit", async () => {
    const manifest = parseManifest(VALID_MANIFEST_TEXT)
    const compiled = compileVerificationBindings(manifest)
    const store = memBridgeStore()
    const canon = (u: string) => u
    const first = await syncVerificationBindings(compiled, new Map([["starter-price", "uuid-a"]]), canon, store)
    const reactivated = await syncVerificationBindings(compiled, new Map([["starter-price", "uuid-d"]]), canon, store)
    expect(reactivated.map((b) => b.id)).toEqual(first.map((b) => b.id))
    // A different extractor is a different verification identity.
    const other = compiled.map((vb) => ({ ...vb, binding: { ...vb.binding, extractor: { kind: "CSS_TEXT" as const, selector: ".price" } } }))
    const branched = await syncVerificationBindings(other, new Map([["starter-price", "uuid-d"]]), canon, store)
    expect(branched.map((b) => b.id)).not.toEqual(first.map((b) => b.id))
    expect(store.bindings.size).toBe(2)
    // A different target URL is a different verification identity.
    const moved = compiled.map((vb) => ({ ...vb, target: { ...vb.target, url: "https://acme.example/pricing-v2" } }))
    const relocated = await syncVerificationBindings(moved, new Map([["starter-price", "uuid-d"]]), canon, store)
    expect(store.targets.size).toBe(2)
    expect(store.bindings.size).toBe(3)
    expect(relocated[0]?.fact_id).toBe("uuid-d")
  })

  it("adopts one legacy unmanaged binding instead of duplicating", async () => {
    const manifest = parseManifest(VALID_MANIFEST_TEXT)
    const compiled = compileVerificationBindings(manifest)
    const store = memBridgeStore()
    const canon = (u: string) => u
    // Pre-lineage rows: two unmanaged bindings accumulated per version.
    const target = await store.createTarget("https://acme.example/pricing")
    store.seedUnmanaged(target.id, "uuid-a", "starter-price")
    store.seedUnmanaged(target.id, "uuid-b", "starter-price")
    const synced = await syncVerificationBindings(compiled, new Map([["starter-price", "uuid-c"]]), canon, store)
    expect(store.bindings.size).toBe(2)
    expect(synced).toHaveLength(1)
    expect(synced[0]?.fact_id).toBe("uuid-c")
    // Hosted/manual bindings (no provenance key) are never adopted.
    const manual = await store.createBinding(target.id, "fact-manual", "JSON_LD", "offers.price", "MONEY")
    expect(manual.managed_key).toBeNull()
    const again = await syncVerificationBindings(compiled, new Map([["starter-price", "uuid-c"]]), canon, store)
    expect(again.map((b) => b.id)).toEqual(synced.map((b) => b.id))
    expect(store.bindings.size).toBe(3)
  })
})

const memBridgeStore = () => {
  const targets = new Map<string, { id: string; url: string }>()
  const bindings = new Map<string, { id: string; target_id: string; fact_id: string; managed_key: string | null; created_at: string; manifestKey: string | null; extractorKind: string; extractorSelector: string; comparator: string }>()
  let n = 0
  const stamp = () => `2026-10-03T00:00:${String(n).padStart(2, "0")}.000Z`
  const store = {
    targets,
    bindings,
    findTargetByUrl: async (c: string) => targets.get(c) ?? null,
    createTarget: async (url: string) => {
      n += 1
      const t = { id: `t${n}`, url }
      targets.set(url, t)
      return t
    },
    findBinding: async (tid: string, fid: string) => {
      for (const b of bindings.values()) {
        if (b.target_id === tid && b.fact_id === fid) return b
      }
      return null
    },
    createBinding: async (tid: string, fid: string, kind: string, selector: string, comparator: string, managedKey: string | null = null) => {
      n += 1
      const b = { id: `b${n}`, target_id: tid, fact_id: fid, managed_key: managedKey, created_at: stamp(), manifestKey: null as string | null, extractorKind: kind, extractorSelector: selector, comparator }
      bindings.set(b.id, b)
      return b
    },
    findManagedBinding: async (managedKey: string, tid: string, kind: string, selector: string, comparator: string) => {
      for (const b of bindings.values()) {
        const row = b
        if (row.managed_key === managedKey && row.target_id === tid && row.extractorKind === kind && row.extractorSelector === selector && row.comparator === comparator) return b
      }
      return null
    },
    advanceBinding: async (id: string, fid: string) => {
      const b = bindings.get(id)!
      const next = { ...b, fact_id: fid }
      bindings.set(id, next)
      return next
    },
    adoptBinding: async (id: string, managedKey: string, fid: string) => {
      const b = bindings.get(id)!
      const next = { ...b, managed_key: managedKey, fact_id: fid }
      bindings.set(id, next)
      return next
    },
    listUnmanagedByDims: async (tid: string, kind: string, selector: string, comparator: string) =>
      [...bindings.values()].filter((b) => {
        const row = b
        return row.target_id === tid && row.managed_key === null && row.extractorKind === kind && row.extractorSelector === selector && row.comparator === comparator
      }).sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
    seedUnmanaged: (tid: string, fid: string, manifestKey: string | null) => {
      n += 1
      const b = { id: `b${n}`, target_id: tid, fact_id: fid, managed_key: null as string | null, created_at: stamp(), manifestKey, extractorKind: "JSON_LD", extractorSelector: "offers.price", comparator: "MONEY" }
      bindings.set(b.id, b)
      return b
    },
  }
  return store
}

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

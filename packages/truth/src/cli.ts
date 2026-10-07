// Thin operator wrapper over the canonical truth library. No duplicated
// manifest/compiler semantics: every command calls the single implementation
// in this package (DB sync delegates row access to @openrecord/db).
// Usage: pnpm --filter @openrecord/truth truth <validate|plan|apply|sync> ...

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { applyArtifact, type ApplyIo } from "./apply.js"
import { compileVerificationBindings, syncVerificationBindings } from "./bridge.js"
import { compileProjection } from "./compiler.js"
import { EMPTY_LOCK, planProjection, planStale, type ProjectionLock } from "./plan.js"
import { parseManifest } from "./manifest.js"
import { syncManifestFacts } from "./service.js"

const usage = `usage: truth <validate|plan|apply|sync> --manifest <openrecord.yaml> [--root <dir>] [--revision <sha>] [--actor <kind:id>]`

const args = (name: string): string | null => {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : (process.argv[i + 1] ?? null)
}

const main = async (): Promise<void> => {
  const cmd = process.argv[2]
  const manifestPath = args("--manifest")
  if (!cmd || !manifestPath) {
    console.error(usage)
    process.exit(2)
  }
  const root = resolve(args("--root") ?? process.cwd())
  const text = await readFile(manifestPath, "utf8")
  const manifest = parseManifest(text)
  const revision = args("--revision")
  const actorArg = args("--actor") ?? "UNKNOWN"
  const [kind = "UNKNOWN", id] = actorArg.split(":")
  const actor = { kind: (["HUMAN", "AGENT", "SYSTEM", "UNKNOWN"].includes(kind) ? kind : "UNKNOWN") as "HUMAN" | "AGENT" | "SYSTEM" | "UNKNOWN", id: id ?? null }
  const now = new Date().toISOString()

  if (cmd === "validate") {
    console.log(`valid ${manifest.business_key} facts=${manifest.facts.length} projections=${manifest.projections.length} digest=${manifest.digest}`)
    return
  }

  if (cmd === "plan" || cmd === "apply") {
    // Local plan/apply resolve facts from the manifest itself: the manifest
    // IS the desired truth; no database read is required to render it.
    // Offline refs prove manifest key + digest only — never a fact UUID.
    const lock = await readLock(root)
    const ids = new Set(manifest.projections.map((p) => p.id))
    for (const spec of manifest.projections) {
      const resolved = new Map(
        manifest.facts.map((f) => [
          f.key,
          { key: f.key, value: f.value, ref: { kind: "MANIFEST_FACT" as const, key: f.key, manifest_digest: manifest.digest } },
        ]),
      )
      const artifact = compileProjection(manifest, spec.id, resolved)
      if (cmd === "plan") {
        const entry = await planProjection(artifact, fileIo(root), lock)
        console.log(`${entry.action} ${entry.output_path} desired=${entry.desired_digest} existing=${entry.existing_digest ?? "-"} (${entry.reason})`)
        continue
      }
      const { entry, receipt } = await applyArtifact(
        artifact,
        { businessKey: manifest.business_key, manifestDigest: manifest.digest, actor, now, newId: () => `receipt-${Date.now()}-${spec.id}` },
        fileIo(root),
      )
      console.log(`${entry.action} ${entry.output_path}${receipt ? ` receipt=${receipt.id} after=${receipt.after_digest}` : " (no receipt: not applied)"}`)
    }
    const stale = planStale(lock, ids, () => null)
    for (const s of stale) console.log(`${s.action} ${s.projection_id}`)
    return
  }

  if (cmd === "sync") {
    const databaseUrl = process.env["DATABASE_URL"]
    if (!databaseUrl) {
      console.error("sync requires DATABASE_URL")
      process.exit(2)
    }
    const { pgSyncStore, pgBridgeStore } = await import("@openrecord/db")
    const { normalizeUrl } = await import("@openrecord/representation")
    const businessId = args("--business-id")
    if (!businessId) {
      console.error("sync requires --business-id")
      process.exit(2)
    }
    const store = pgSyncStore(databaseUrl)
    try {
      const result = await syncManifestFacts(manifest, businessId, store, { sourceRevision: revision, now })
      console.log(`synced created=[${result.created}] superseded=[${result.superseded}] reactivated=[${result.reactivated}] retired=[${result.retired}] unchanged=[${result.unchanged}]`)
      // Wire existing verification bindings into hosted representation
      // storage: idempotent target/binding reconciliation reusing canonical
      // URL semantics. Fact keys resolve to the just-synchronized real ids.
      // A binding failure is reported honestly without claiming verification.
      const bridge = pgBridgeStore(databaseUrl, businessId)
      try {
        const descriptors = compileVerificationBindings(manifest)
        const factIds = new Map(
          [...result.resolved.entries()].map(([key, r]) => {
            const ref = r.ref
            if (ref.kind !== "AUTHORITATIVE_FACT") throw new Error(`UnresolvedAuthorityRef: ${key}`)
            return [key, ref.fact_id] as const
          }),
        )
        const bound = await syncVerificationBindings(descriptors, factIds, normalizeUrl, bridge)
        console.log(`verification bindings reconciled: ${bound.length} (targets/bindings reused or created)`)
      } catch (e) {
        console.error(`verification binding reconciliation failed (source verification NOT configured): ${e instanceof Error ? e.message : e}`)
        process.exitCode = 1
      } finally {
        await bridge.close()
      }
    } finally {
      await store.close()
    }
    return
  }

  console.error(usage)
  process.exit(2)
}

const readLock = async (root: string): Promise<ProjectionLock> => {
  let raw: string
  try {
    raw = await readFile(resolve(root, ".openrecord/projections.lock.json"), "utf8")
  } catch (e) {
    // Missing lock means a fresh root: nothing is managed yet.
    // Any other read failure leaves lock state unknown, so fail closed.
    if ((e as { code?: string }).code === "ENOENT") return EMPTY_LOCK
    throw e
  }
  const parsed: unknown = JSON.parse(raw)
  if (parsed !== null && typeof parsed === "object" && "projections" in parsed) {
    return parsed as ProjectionLock
  }
  throw new Error("projections.lock.json has invalid shape; refusing to apply with unknown lock state")
}

const fileIo = (root: string): ApplyIo => ({
  root,
  read: async (rel) => {
    try {
      return new Uint8Array(await readFile(resolve(root, rel)))
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") return null
      throw e
    }
  },
  readLock: () => readLock(root),
  writeLock: async (lock) => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(resolve(root, ".openrecord"), { recursive: true })
    await writeFile(resolve(root, ".openrecord/projections.lock.json"), `${JSON.stringify(lock, null, 2)}\n`)
  },
  appendReceipt: async (receipt) => {
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(resolve(root, ".openrecord/receipts"), { recursive: true })
    await writeFile(resolve(root, `.openrecord/receipts/${receipt.id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" })
  },
})

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})

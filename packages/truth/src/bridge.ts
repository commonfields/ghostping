// Representation Graph bridge: projection `verify` blocks compile into
// the EXISTING SourceTarget / SourceBinding representation. No second
// verification engine: HTTP collection, extraction, comparison, and
// IN_SYNC / DRIFT / UNKNOWN stay in @openrecord/representation.

import type { TruthManifestV1 } from "./manifest.js"

export interface TargetDescriptor {
  readonly url: string
  readonly control: "OWNED"
}

export interface BindingDescriptor {
  readonly fact_key: string
  readonly extractor: { readonly kind: "JSON_LD" | "CSS_TEXT" | "META_CONTENT"; readonly selector: string }
  readonly comparator: "EXACT_TEXT" | "BOOLEAN" | "MONEY"
}

export interface VerificationBinding {
  readonly projection_id: string
  readonly target: TargetDescriptor
  readonly binding: BindingDescriptor
}

/** Every projection's verify block becomes one target + one binding. */
export const compileVerificationBindings = (manifest: TruthManifestV1): VerificationBinding[] =>
  manifest.projections.map((p) => ({
    projection_id: p.id,
    target: { url: p.verify.url, control: "OWNED" as const },
    binding: {
      fact_key: primaryFactKey(manifest, p.id),
      extractor: p.verify.extractor,
      comparator: p.verify.comparator,
    },
  }))

const primaryFactKey = (manifest: TruthManifestV1, projectionId: string): string => {
  const spec = manifest.projections.find((p) => p.id === projectionId)
  const refs = new Set<string>()
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const r = node as Record<string, unknown>
    if (typeof r["fact"] === "string" && typeof r["component"] === "string") {
      refs.add(r["fact"] as string)
      return
    }
    Object.values(r).forEach(walk)
  }
  walk(spec?.document)
  const [first] = [...refs].sort()
  if (first === undefined) throw new Error(`NoFactReference: ${projectionId}`)
  return first
}

export interface BridgeTarget {
  readonly id: string
  readonly url: string
}

export interface BridgeBinding {
  readonly id: string
  readonly target_id: string
  readonly fact_id: string
  readonly managed_key: string | null
  readonly created_at: string
}

export interface BridgeStore {
  readonly findTargetByUrl: (canonicalUrl: string) => Promise<BridgeTarget | null>
  readonly createTarget: (url: string) => Promise<BridgeTarget>
  readonly findBinding: (targetId: string, factId: string, extractorKind: string, selector: string, comparator: string) => Promise<BridgeBinding | null>
  readonly createBinding: (targetId: string, factId: string, extractorKind: string, selector: string, comparator: string, managedKey?: string | null) => Promise<BridgeBinding>
  /** Logical repository binding: one row per (manifest key, target, extractor, comparator). */
  readonly findManagedBinding: (managedKey: string, targetId: string, extractorKind: string, selector: string, comparator: string) => Promise<BridgeBinding | null>
  /** Advance a managed binding to the current authority fact (same row id). */
  readonly advanceBinding: (id: string, factId: string) => Promise<BridgeBinding>
  /**
   * Claim one unmanaged row for a manifest lineage: sets its managed key
   * and current fact id at once. Used once to adopt pre-lineage duplicates.
   */
  readonly adoptBinding: (id: string, managedKey: string, factId: string) => Promise<BridgeBinding>
  /**
   * Unmanaged bindings with identical target/extractor/comparator, oldest
   * first, each annotated with its fact's manifest key (null when the fact
   * has no repository provenance). Used once to adopt legacy duplicates.
   */
  readonly listUnmanagedByDims: (targetId: string, extractorKind: string, selector: string, comparator: string) => Promise<Array<BridgeBinding & { manifestKey: string | null }>>
}

/**
 * Idempotent binding sync on LOGICAL lineage identity
 * (manifest key + target + extractor + comparator), never the mutable
 * fact UUID. A fact version change advances the same binding row to the
 * current authority id; no duplicate bindings accumulate and no
 * authoritative value is ever copied into the binding.
 *
 * Hosted/manual bindings (managed_key null, no provenance key) are never
 * adopted or advanced by this path.
 */
export const syncVerificationBindings = async (
  bindings: VerificationBinding[],
  factIds: Map<string, string>,
  canonicalize: (url: string) => string | null,
  store: BridgeStore,
): Promise<BridgeBinding[]> => {
  const out: BridgeBinding[] = []
  for (const vb of bindings) {
    const factId = factIds.get(vb.binding.fact_key)
    if (factId === undefined) throw new Error(`DanglingFactReference: ${vb.binding.fact_key}`)
    const canonical = canonicalize(vb.target.url)
    if (canonical === null) throw new Error(`InvalidVerifyUrl: ${vb.target.url}`)
    const target = (await store.findTargetByUrl(canonical)) ?? (await store.createTarget(vb.target.url))
    const { kind, selector } = vb.binding.extractor
    const managed = await store.findManagedBinding(vb.binding.fact_key, target.id, kind, selector, vb.binding.comparator)
    if (managed !== null) {
      out.push(managed.fact_id === factId ? managed : await store.advanceBinding(managed.id, factId))
      continue
    }
    // Adopt the oldest same-lineage unmanaged row (pre-lineage deployments)
    // instead of duplicating; otherwise create one managed row.
    const legacy = (await store.listUnmanagedByDims(target.id, kind, selector, vb.binding.comparator)).find(
      (c) => c.manifestKey === vb.binding.fact_key,
    )
    if (legacy !== undefined) {
      out.push(await store.adoptBinding(legacy.id, vb.binding.fact_key, factId))
      continue
    }
    out.push(await store.createBinding(target.id, factId, kind, selector, vb.binding.comparator, vb.binding.fact_key))
  }
  return out
}

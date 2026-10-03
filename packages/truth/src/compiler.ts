// Deterministic projection compiler V1: manifest + resolved canonical
// facts -> canonical JSON bytes + SHA-256. Same inputs + compiler version
// always produce exactly the same bytes. No timestamps, randomness,
// machine paths, or network. One canonical writer implementation.

import { canonicalJson, sha256Hex, TRUTH_COMPILER_VERSION, type ManifestFactV1, type ProjectionNode, type TruthManifestV1 } from "./manifest.js"
import { ManifestInvalid } from "./values.js"

export interface ResolvedFact {
  readonly key: string
  readonly fact_id: string
  readonly version: number
  readonly value: ManifestFactV1["value"]
}

export interface ProjectionArtifactV1 {
  readonly schema: "ghostping/projection-artifact-v1"
  readonly schema_version: 1
  readonly projection_id: string
  readonly kind: "JSON_LD"
  readonly relative_output_path: string
  readonly source_fact_versions: ReadonlyArray<{ readonly key: string; readonly fact_id: string; readonly version: number }>
  readonly compiler_version: typeof TRUTH_COMPILER_VERSION
  readonly media_type: "application/ld+json"
  readonly canonical_bytes: string
  readonly digest_sha256: string
}

const componentValue = (fact: ResolvedFact, component: string): string | boolean => {
  const v = fact.value
  if (v.type === "text") {
    if (component !== "value") throw new ManifestInvalid("ComponentTypeMismatch", `${fact.key}.${component}`)
    return v.value
  }
  if (v.type === "boolean") {
    if (component !== "value") throw new ManifestInvalid("ComponentTypeMismatch", `${fact.key}.${component}`)
    return v.value
  }
  if (component === "amount") return v.amount
  if (component === "currency") return v.currency
  throw new ManifestInvalid("ComponentTypeMismatch", `${fact.key}.${component}`)
}

export const resolveNode = (node: ProjectionNode, facts: Map<string, ResolvedFact>, where: string): unknown => {
  if (node === null || typeof node === "string" || typeof node === "boolean") return node
  if (typeof node === "number") throw new ManifestInvalid("LiteralNumberForbidden", where)
  if (Array.isArray(node)) return node.map((el, i) => resolveNode(el, facts, `${where}[${i}]`))
  if ("fact" in node && "component" in node) {
    const ref = node as { fact: string; component: string }
    const fact = facts.get(ref.fact)
    if (!fact) throw new ManifestInvalid("DanglingFactReference", `${where}: ${ref.fact}`)
    return componentValue(fact, ref.component)
  }
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(node as Record<string, ProjectionNode>)) out[k] = resolveNode(x, facts, `${where}.${k}`)
  return out
}

/** Compile one projection. Throws ManifestInvalid on dangling refs. */
export const compileProjection = (
  manifest: TruthManifestV1,
  projectionId: string,
  facts: Map<string, ResolvedFact>,
): ProjectionArtifactV1 => {
  const spec = manifest.projections.find((p) => p.id === projectionId)
  if (!spec) throw new ManifestInvalid("UnknownProjection", projectionId)
  const resolved = resolveNode(spec.document, facts, `projections.${projectionId}.document`)
  const canonical = canonicalJson(resolved)
  const used = [...collectRefs(spec.document)]
    .map((key) => facts.get(key))
    .filter((f): f is ResolvedFact => f !== undefined)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return {
    schema: "ghostping/projection-artifact-v1",
    schema_version: 1,
    projection_id: projectionId,
    kind: "JSON_LD",
    relative_output_path: spec.output,
    source_fact_versions: used.map((f) => ({ key: f.key, fact_id: f.fact_id, version: f.version })),
    compiler_version: TRUTH_COMPILER_VERSION,
    media_type: "application/ld+json",
    canonical_bytes: canonical,
    digest_sha256: sha256Hex(canonical),
  }
}

const collectRefs = (node: ProjectionNode): Set<string> => {
  const out = new Set<string>()
  const walk = (n: ProjectionNode): void => {
    if (n === null || typeof n !== "object") return
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if ("fact" in n && "component" in n) {
      out.add((n as { fact: string }).fact)
      return
    }
    Object.values(n as Record<string, ProjectionNode>).forEach(walk)
  }
  walk(node)
  return out
}

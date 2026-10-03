// Truth manifest V1: versioned, fail-closed `ghostping.yaml` parsing.
// No env interpolation, no executable config, no JS, no YAML tags capable
// of object construction, no anchors/aliases. Unknown fields rejected.

import { createHash } from "node:crypto"
import { isAlias, isMap, isScalar, parseDocument } from "yaml"
import { ManifestInvalid, parseManifestValue, type ManifestValue } from "./values.js"

export const TRUTH_MANIFEST_SCHEMA = "ghostping/truth-manifest-v1" as const
export const PROJECTION_ARTIFACT_SCHEMA = "ghostping/projection-artifact-v1" as const
export const MATERIALIZATION_RECEIPT_SCHEMA = "ghostping/materialization-receipt-v1" as const
export const TRUTH_COMPILER_VERSION = "truth-compiler/1" as const

export interface ManifestFactV1 {
  readonly key: string
  readonly subject: string
  readonly predicate: string
  readonly value: ManifestValue
  readonly valid_from: string
  readonly valid_until: string | null
  readonly source_url: string | null
}

export interface FactRef {
  readonly fact: string
  readonly component: string
}

export type ProjectionNode = string | number | boolean | null | FactRef | { [k: string]: ProjectionNode } | ProjectionNode[]

export interface ProjectionSpecV1 {
  readonly id: string
  readonly kind: "JSON_LD"
  readonly output: string
  readonly document: ProjectionNode
  readonly verify: {
    readonly url: string
    readonly extractor: { readonly kind: "JSON_LD" | "CSS_TEXT" | "META_CONTENT"; readonly selector: string }
    readonly comparator: "EXACT_TEXT" | "BOOLEAN" | "MONEY"
  }
}

export interface TruthManifestV1 {
  readonly schema: typeof TRUTH_MANIFEST_SCHEMA
  readonly business_key: string
  readonly facts: ReadonlyArray<ManifestFactV1>
  readonly projections: ReadonlyArray<ProjectionSpecV1>
  /** SHA-256 over canonical JSON of the normalized manifest. */
  readonly digest: string
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

const rejectSurplus = (obj: Record<string, unknown>, allowed: ReadonlyArray<string>, where: string): void => {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ManifestInvalid("UnknownField", `${where}.${k}`)
  }
}

const requireString = (v: unknown, where: string): string => {
  if (typeof v !== "string" || v.length === 0) throw new ManifestInvalid("InvalidString", where)
  return v
}

const checkTimestamp = (v: unknown, where: string): string => {
  if (typeof v !== "string" || !TIMESTAMP.test(v)) {
    throw new ManifestInvalid("MalformedTimestamp", where)
  }
  const t = Date.parse(v)
  if (Number.isNaN(t)) throw new ManifestInvalid("MalformedTimestamp", where)
  // Canonical instant form (always millis) so manifest state compares equal
  // to database TIMESTAMPTZ round-trips and sync stays idempotent.
  return new Date(t).toISOString()
}

const checkNoInterpolation = (s: string, where: string): void => {
  if (s.includes("${")) throw new ManifestInvalid("InterpolationForbidden", where)
}

const checkOutputPath = (p: unknown): string => {
  if (typeof p !== "string" || p.length === 0) throw new ManifestInvalid("InvalidOutputPath", String(p))
  if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)) throw new ManifestInvalid("AbsoluteOutputPath", p)
  const parts = p.split("/")
  if (parts.some((seg) => seg === ".." || seg === "")) throw new ManifestInvalid("UnsafeOutputPath", p)
  if (parts[0] === ".ghostping" || p === ".ghostping") throw new ManifestInvalid("ReservedOutputPath", p)
  if (p.includes(".git/") || p.startsWith(".git/")) throw new ManifestInvalid("ReservedOutputPath", p)
  return p
}

const COMPONENTS: Record<string, ReadonlyArray<string>> = {
  text: ["value"],
  boolean: ["value"],
  money: ["amount", "currency"],
}

const parseDocumentNode = (node: unknown, where: string, factTypes: Map<string, string>): ProjectionNode => {
  if (node === null || typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    if (typeof node === "string") checkNoInterpolation(node, where)
    if (typeof node === "number") throw new ManifestInvalid("LiteralNumberForbidden", where)
    return node
  }
  if (Array.isArray(node)) return node.map((el, i) => parseDocumentNode(el, `${where}[${i}]`, factTypes))
  if (!isRecord(node)) throw new ManifestInvalid("InvalidDocumentNode", where)
  const keys = Object.keys(node)
  if (keys.length === 2 && typeof node["fact"] === "string" && typeof node["component"] === "string") {
    const key = node["fact"] as string
    const component = node["component"] as string
    const ftype = factTypes.get(key)
    if (ftype === undefined) throw new ManifestInvalid("DanglingFactReference", `${where}: ${key}`)
    if (!(COMPONENTS[ftype] ?? []).includes(component)) {
      throw new ManifestInvalid("ComponentTypeMismatch", `${where}: ${ftype}.${component}`)
    }
    return { fact: key, component }
  }
  const out: Record<string, ProjectionNode> = {}
  for (const k of keys) out[k] = parseDocumentNode(node[k], `${where}.${k}`, factTypes)
  return out
}

/** Deterministic canonical JSON: sorted keys, no whitespace. */
export const canonicalJson = (v: unknown): string => {
  if (v === null || typeof v !== "object") {
    if (typeof v === "string") return JSON.stringify(v) ?? '""'
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new ManifestInvalid("NonFiniteNumber")
      return JSON.stringify(v) ?? "0"
    }
    return JSON.stringify(v) ?? "null"
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(",")}}`
}

export const sha256Hex = (s: string | Uint8Array): string =>
  createHash("sha256").update(s).digest("hex")

const scanScalars = (v: unknown, where: string): void => {
  if (typeof v === "string") {
    checkNoInterpolation(v, where)
    return
  }
  if (Array.isArray(v)) {
    v.forEach((el, i) => scanScalars(el, `${where}[${i}]`))
    return
  }
  if (isRecord(v)) {
    for (const [k, x] of Object.entries(v)) scanScalars(x, `${where}.${k}`)
  }
}

/** Reject YAML tags/anchors/aliases capable of object construction. */
const rejectExecutableYaml = (doc: ReturnType<typeof parseDocument>): void => {
  const anchors = (doc as { anchors?: unknown }).anchors
  if (anchors !== undefined && anchors !== null && Object.keys(anchors as Record<string, unknown>).length > 0) {
    throw new ManifestInvalid("YamlAnchorsForbidden")
  }
  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return
    if (isAlias(node)) throw new ManifestInvalid("YamlAliasesForbidden")
    const tag = (node as { tag?: unknown }).tag
    if (typeof tag === "string" && !tag.startsWith("tag:yaml.org,2002:")) {
      throw new ManifestInvalid("YamlTagForbidden", tag)
    }
    const anchor = (node as { anchor?: unknown }).anchor
    if (typeof anchor === "string" && anchor.length > 0) throw new ManifestInvalid("YamlAnchorsForbidden")
    if (isMap(node)) {
      for (const item of node.items) {
        const pair = item as { key?: unknown; value?: unknown }
        visit(pair.key)
        visit(pair.value)
      }
      return
    }
    if (isScalar(node)) return
    if (Array.isArray((node as { items?: unknown }).items)) {
      for (const el of (node as { items: Array<unknown> }).items) visit(el)
    }
  }
  visit(doc.contents)
}

export const parseManifest = (text: string): TruthManifestV1 => {
  const doc = parseDocument(text, { uniqueKeys: true, schema: "core" } as Parameters<typeof parseDocument>[1])
  if (doc.errors.length > 0) throw new ManifestInvalid("YamlError", doc.errors[0]?.message)
  rejectExecutableYaml(doc)
  const root: unknown = doc.toJS({ mapAsMap: false })
  if (!isRecord(root)) throw new ManifestInvalid("RootMustBeMap")
  rejectSurplus(root, ["schema", "business", "authority", "facts", "projections"], "manifest")
  if (root["schema"] !== TRUTH_MANIFEST_SCHEMA) throw new ManifestInvalid("UnknownSchema", String(root["schema"]))
  if (!isRecord(root["business"])) throw new ManifestInvalid("InvalidBusiness")
  rejectSurplus(root["business"], ["key"], "business")
  const businessKey = requireString(root["business"]["key"], "business.key")
  if (!isRecord(root["authority"])) throw new ManifestInvalid("InvalidAuthority")
  rejectSurplus(root["authority"], ["mode"], "authority")
  if (root["authority"]["mode"] !== "repository") throw new ManifestInvalid("AuthorityModeMustBeRepository", String(root["authority"]["mode"]))
  const factsRaw: Record<string, unknown> = isRecord(root["facts"]) ? root["facts"] : {}
  const projectionsRaw: Record<string, unknown> = isRecord(root["projections"]) ? root["projections"] : {}
  if (root["facts"] !== undefined && root["facts"] !== null && !isRecord(root["facts"])) throw new ManifestInvalid("FactsAndProjectionsMustBeMaps")
  if (root["projections"] !== undefined && root["projections"] !== null && !isRecord(root["projections"])) throw new ManifestInvalid("FactsAndProjectionsMustBeMaps")

  const factTypes = new Map<string, string>()
  const facts: ManifestFactV1[] = []
  for (const [key, raw] of Object.entries(factsRaw)) {
    if (!isRecord(raw)) throw new ManifestInvalid("InvalidFact", key)
    rejectSurplus(raw, ["subject", "predicate", "type", "value", "valid_from", "valid_until", "source"], `facts.${key}`)
    const subject = requireString(raw["subject"], `facts.${key}.subject`)
    const predicate = requireString(raw["predicate"], `facts.${key}.predicate`)
    const ftype = requireString(raw["type"], `facts.${key}.type`)
    if (ftype !== "text" && ftype !== "boolean" && ftype !== "money") throw new ManifestInvalid("InvalidFactType", `facts.${key}.type`)
    const value = parseManifestValue(ftype, raw["value"])
    const validFrom = checkTimestamp(raw["valid_from"], `facts.${key}.valid_from`)
    const validUntil = raw["valid_until"] === undefined || raw["valid_until"] === null ? null : checkTimestamp(raw["valid_until"], `facts.${key}.valid_until`)
    let sourceUrl: string | null = null
    if (raw["source"] !== undefined && raw["source"] !== null) {
      if (!isRecord(raw["source"])) throw new ManifestInvalid("InvalidSource", `facts.${key}.source`)
      rejectSurplus(raw["source"], ["url"], `facts.${key}.source`)
      sourceUrl = requireString(raw["source"]["url"], `facts.${key}.source.url`)
      try {
        const u = new URL(sourceUrl)
        if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme")
      } catch {
        throw new ManifestInvalid("InvalidSourceUrl", `facts.${key}.source.url`)
      }
    }
    scanScalars(raw["value"], `facts.${key}.value`)
    factTypes.set(key, ftype)
    facts.push({ key, subject, predicate, value, valid_from: validFrom, valid_until: validUntil, source_url: sourceUrl })
  }

  const projections: ProjectionSpecV1[] = []
  for (const [id, raw] of Object.entries(projectionsRaw)) {
    if (!isRecord(raw)) throw new ManifestInvalid("InvalidProjection", id)
    rejectSurplus(raw, ["kind", "output", "document", "verify"], `projections.${id}`)
    if (raw["kind"] !== "JSON_LD") throw new ManifestInvalid("UnsupportedProjectionKind", `projections.${id}.kind`)
    const output = checkOutputPath(raw["output"])
    if (!isRecord(raw["document"])) throw new ManifestInvalid("InvalidDocument", `projections.${id}.document`)
    const document = parseDocumentNode(raw["document"], `projections.${id}.document`, factTypes)
    if (!isRecord(raw["verify"])) throw new ManifestInvalid("InvalidVerify", `projections.${id}.verify`)
    rejectSurplus(raw["verify"], ["url", "extractor", "comparator"], `projections.${id}.verify`)
    const verifyUrl = requireString(raw["verify"]["url"], `projections.${id}.verify.url`)
    try {
      const u = new URL(verifyUrl)
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme")
    } catch {
      throw new ManifestInvalid("InvalidVerifyUrl", `projections.${id}.verify.url`)
    }
    if (!isRecord(raw["verify"]["extractor"])) throw new ManifestInvalid("InvalidExtractor", `projections.${id}.verify.extractor`)
    rejectSurplus(raw["verify"]["extractor"], ["kind", "selector"], `projections.${id}.verify.extractor`)
    const ekind = raw["verify"]["extractor"]["kind"]
    if (ekind !== "JSON_LD" && ekind !== "CSS_TEXT" && ekind !== "META_CONTENT") {
      throw new ManifestInvalid("InvalidExtractorKind", `projections.${id}.verify.extractor.kind`)
    }
    const selector = requireString(raw["verify"]["extractor"]["selector"], `projections.${id}.verify.extractor.selector`)
    const comparator = raw["verify"]["comparator"]
    if (comparator !== "EXACT_TEXT" && comparator !== "BOOLEAN" && comparator !== "MONEY") {
      throw new ManifestInvalid("InvalidComparator", `projections.${id}.verify.comparator`)
    }
    projections.push({ id, kind: "JSON_LD", output, document, verify: { url: verifyUrl, extractor: { kind: ekind, selector }, comparator } })
  }

  const normalized = {
    schema: TRUTH_MANIFEST_SCHEMA,
    business: { key: businessKey },
    authority: { mode: "repository" },
    facts: Object.fromEntries(facts.map((f) => [f.key, factToJson(f)])),
    projections: Object.fromEntries(projections.map((p) => [p.id, projectionToJson(p)])),
  }
  return { schema: TRUTH_MANIFEST_SCHEMA, business_key: businessKey, facts, projections, digest: sha256Hex(canonicalJson(normalized)) }
}

const factToJson = (f: ManifestFactV1): unknown => ({
  predicate: f.predicate,
  source: f.source_url === null ? null : { url: f.source_url },
  subject: f.subject,
  type: f.value.type,
  valid_from: f.valid_from,
  valid_until: f.valid_until,
  value: valueToJson(f.value),
})

const valueToJson = (v: ManifestValue): unknown =>
  v.type === "money" ? { amount: v.amount, currency: v.currency } : v.value

const projectionToJson = (p: ProjectionSpecV1): unknown => ({
  document: p.document,
  kind: p.kind,
  output: p.output,
  verify: {
    comparator: p.verify.comparator,
    extractor: { kind: p.verify.extractor.kind, selector: p.verify.extractor.selector },
    url: p.verify.url,
  },
})

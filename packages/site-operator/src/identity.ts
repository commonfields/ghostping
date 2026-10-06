// Finding identity: repeated identical inspections must not create
// uncontrolled duplicates. Identity = business + normalized URL +
// finding_kind + evidence digest (stable for identical observations).
import { createHash } from "node:crypto"
import type { FindingKind } from "./types.js"

export const normalizeFindingUrl = (url: string): string => {
  try {
    const u = new URL(url)
    u.hash = ""
    if (u.pathname !== "/" && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1)
    return u.toString()
  } catch {
    return url
  }
}

const stableStringify = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`
  const rec = v as Record<string, unknown>
  return `{${Object.keys(rec)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(rec[k])}`)
    .join(",")}}`
}

export const evidenceDigest = (evidence: Record<string, unknown>): string =>
  createHash("sha256").update(stableStringify(evidence), "utf8").digest("hex")

export const findingIdentityKey = (args: {
  businessId: string
  url: string
  findingKind: FindingKind
  evidence: Record<string, unknown>
}): string => {
  const digest = evidenceDigest(args.evidence)
  return createHash("sha256")
    .update(`${args.businessId}|${normalizeFindingUrl(args.url)}|${args.findingKind}|${digest}`, "utf8")
    .digest("hex")
}

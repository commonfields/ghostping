// Deterministic extractors: JSON_LD, CSS_TEXT, META_CONTENT. No LLM.
// Ambiguity rules: 0 → NOT_FOUND, 1 → OBSERVED, >1 distinct → AMBIGUOUS.

import { load } from "cheerio"
import type { ExtractionState } from "./types.js"

export interface ExtractionResult {
  readonly state: ExtractionState
  readonly value: string | null
  readonly node_identity: string | null
}

const normalize = (s: string): string => s.normalize("NFC").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()

const getPath = (obj: unknown, path: string): unknown[] => {
  // Dotted path with optional [n] index, e.g. "offers.price" or "offers[0].price".
  const parts = path.split(".").filter((p) => p.length > 0)
  let current: unknown[] = [obj]
  for (const part of parts) {
    const m = part.match(/^(?<key>[^\[]+)(?<idx>\[\d+\])?$/)
    if (!m || !m.groups) return []
    const key = m.groups["key"] as string
    const idx = m.groups["idx"] as string | undefined
    const next: unknown[] = []
    for (const c of current) {
      if (c !== null && typeof c === "object" && !Array.isArray(c)) {
        const v = (c as Record<string, unknown>)[key]
        if (v === undefined) continue
        if (idx !== undefined) {
          const n = Number(idx.slice(1, -1))
          if (Array.isArray(v) && n < v.length) next.push(v[n])
        } else if (Array.isArray(v)) next.push(...v)
        else next.push(v)
      } else if (Array.isArray(c)) {
        for (const el of c) {
          if (el !== null && typeof el === "object" && !Array.isArray(el)) {
            const v = (el as Record<string, unknown>)[key]
            if (v === undefined) continue
            next.push(...(Array.isArray(v) ? v : [v]))
          }
        }
      }
    }
    current = next
  }
  return current
}

const scalarText = (v: unknown): string | null => {
  if (typeof v === "string") return v
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  if (typeof v === "boolean") return String(v)
  return null
}

export const extractJsonLd = (html: string, path: string): ExtractionResult => {
  const $ = load(html)
  const blocks: unknown[] = []
  $('script[type="application/ld+json"]').each((i, el) => {
    const text = $(el).html() ?? ""
    try {
      const parsed: unknown = JSON.parse(text)
      blocks.push(parsed)
    } catch {
      // Invalid JSON-LD block is ignored for V1 (other blocks may still match).
    }
  })
  void $ // cheerio instance retained for symmetry; JSON-LD uses script contents.
  const found: string[] = []
  for (const b of blocks) {
    const roots = Array.isArray(b) ? b : [b]
    for (const r of roots) {
      for (const v of getPath(r, path)) {
        const t = scalarText(v)
        if (t !== null) found.push(normalize(t))
      }
    }
  }
  if (found.length === 0) return { state: "NOT_FOUND", value: null, node_identity: null }
  const distinct = [...new Set(found)]
  if (distinct.length > 1) return { state: "AMBIGUOUS", value: null, node_identity: null }
  return { state: "OBSERVED", value: distinct[0] ?? null, node_identity: `json-ld:${path}` }
}

export const extractCssText = (html: string, selector: string): ExtractionResult => {
  let $: ReturnType<typeof load>
  try {
    $ = load(html)
  } catch {
    return { state: "FAILED", value: null, node_identity: null }
  }
  let nodes: string[]
  try {
    nodes = $(selector)
      .toArray()
      .map((el) => normalize($(el).text()))
      .filter((t) => t.length > 0)
  } catch {
    return { state: "UNSUPPORTED", value: null, node_identity: null }
  }
  if (nodes.length === 0) return { state: "NOT_FOUND", value: null, node_identity: null }
  const distinct = [...new Set(nodes)]
  if (distinct.length > 1) return { state: "AMBIGUOUS", value: null, node_identity: null }
  return { state: "OBSERVED", value: distinct[0] ?? null, node_identity: `css:${selector}` }
}

export const extractMetaContent = (html: string, selector: string): ExtractionResult => {
  let $: ReturnType<typeof load>
  try {
    $ = load(html)
  } catch {
    return { state: "FAILED", value: null, node_identity: null }
  }
  let contents: string[]
  try {
    contents = $(selector)
      .toArray()
      .map((el) => normalize(String($(el).attr("content") ?? "")))
      .filter((t) => t.length > 0)
  } catch {
    return { state: "UNSUPPORTED", value: null, node_identity: null }
  }
  if (contents.length === 0) return { state: "NOT_FOUND", value: null, node_identity: null }
  const distinct = [...new Set(contents)]
  if (distinct.length > 1) return { state: "AMBIGUOUS", value: null, node_identity: null }
  return { state: "OBSERVED", value: distinct[0] ?? null, node_identity: `meta:${selector}` }
}

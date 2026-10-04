// Deterministic discovery matcher V1. No LLM, no network.
// Surfaces: JSON-LD (structured), META (structured), VISIBLE_TEXT (prose).
// Money reuses representation comparator semantics exactly (known currency
// required, JPY 0 decimals else 2, minor-unit equality). Booleans never
// match from visible prose. Short values (< 4 chars collapsed) never match
// from visible text.

import { load } from "cheerio"
import { compareMoney, normalizeExactText, parseBoolean, parseMoney } from "@ghostping/representation"
import { MATCHER_VERSION, type CandidateSummary, type DiscoveryMatch } from "./types.js"

export { MATCHER_VERSION }

/** Minimum collapsed visible-text length for a TEXT value to be searchable. */
export const MIN_VISIBLE_TEXT_LENGTH = 4

export type AuthorityValueType = "TEXT" | "CURRENCY" | "BOOLEAN"

export interface HistoricalAuthorityValue {
  readonly factId: string
  readonly version: number
  readonly value: string
}

export interface AuthorityLineage {
  readonly rootId: string
  readonly activeId: string
  readonly activeVersion: number
  readonly valueType: AuthorityValueType
  readonly currentValue: string
  readonly historicalValues: ReadonlyArray<HistoricalAuthorityValue>
}

export interface AuthoritySnapshot {
  readonly lineages: ReadonlyArray<AuthorityLineage>
}

export interface DiscoveryMatchEvent {
  readonly lineageRoot: string
  readonly matchedFact: string
  readonly matchedVersion: number
  readonly matchedValue: string
  readonly surface: "JSON_LD" | "META" | "VISIBLE_TEXT"
  readonly locator: string
  readonly snippet: string
  readonly relation: "CURRENT_VALUE" | "HISTORICAL_VALUE"
}

const SNIPPET_MAX = 512

// Structured TEXT normalization composes the shared representation primitive.
// Discovery keeps its historical trim (padded whitespace ignored on structured
// surfaces); the NFC + CRLF/CR→LF core is owned by @ghostping/representation.
const normalizeExact = (s: string): string => normalizeExactText(s).trim()

// Visible-text collapsing is discovery-specific (prose scanning) but reuses
// the shared NFC + newline core so both packages interpret text identically.
const normalizeVisible = (s: string): string => normalizeExactText(s).replace(/\s+/g, " ").trim()

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// --- Money: shared representation comparator semantics ----------------------
// Parsing and equality are owned by @ghostping/representation (known currency
// required, JPY 0 decimals else 2, minor-unit equality). Discovery composes
// visible-text scanning, JSON-LD object-local pairing, and snippet bounds
// around those primitives.
const moneyEqual = (a: string, b: string): boolean => compareMoney(a, b) === "IN_SYNC"

// --- Booleans: shared representation token sets ----------------------------
// parseBoolean is owned by @ghostping/representation; discovery only decides
// *where* booleans may match (structured surfaces, never visible prose).

// --- Value comparison per surface ------------------------------------------

const structuredEquals = (authority: string, valueType: AuthorityValueType, observed: string): boolean => {
  if (valueType === "TEXT") return normalizeExact(authority) === normalizeExact(observed)
  if (valueType === "CURRENCY") return moneyEqual(authority, observed)
  const a = parseBoolean(authority)
  const b = parseBoolean(observed)
  return a !== null && b !== null && a === b
}

// --- JSON-LD collection -----------------------------------------------------

interface JsonLdLeaf {
  readonly path: string
  readonly text: string
}

const scalarText = (v: unknown): string | null => {
  if (typeof v === "string") return v
  if (typeof v === "number" && Number.isFinite(v)) return String(v)
  if (typeof v === "boolean") return String(v)
  return null
}

const AMOUNT_KEYS = new Set(["price", "lowprice", "highprice", "amount", "value"])
const CURRENCY_KEYS = new Set(["pricecurrency", "currency"])

const collectJsonLd = (html: string): JsonLdLeaf[] => {
  const $ = load(html)
  const leaves: JsonLdLeaf[] = []
  $('script[type="application/ld+json"]').each((_i, el) => {
    const text = $(el).html() ?? ""
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return // malformed block ignored; other blocks still match
    }
    const roots = Array.isArray(parsed) ? parsed : [parsed]
    for (const r of roots) walkJsonLd(r, "$", leaves)
  })
  return leaves
}

const walkJsonLd = (node: unknown, path: string, out: JsonLdLeaf[]): void => {
  if (Array.isArray(node)) {
    node.forEach((el, i) => walkJsonLd(el, `${path}[${i}]`, out))
    return
  }
  if (node !== null && typeof node === "object") {
    const rec = node as Record<string, unknown>
    // Object-local price/priceCurrency pairing: synthesize "<amount> <CUR>".
    const currencyEntry = Object.entries(rec).find(
      ([k, v]) => CURRENCY_KEYS.has(k.toLowerCase()) && typeof v === "string" && /^[A-Z]{3}$/.test(v.trim()),
    )
    if (currencyEntry !== undefined) {
      const cur = (currencyEntry[1] as string).trim()
      for (const [k, v] of Object.entries(rec)) {
        if (!AMOUNT_KEYS.has(k.toLowerCase())) continue
        const t = scalarText(v)
        if (t === null || t.trim() === "") continue
        if (parseMoney(t) !== null && parseMoney(t)?.currency !== null) continue // already qualified
        const amount = Number(String(t).replace(/,/g, ""))
        if (!Number.isFinite(amount)) continue
        out.push({ path: `${path}.${k}+${currencyEntry[0]}`, text: `${t.trim()} ${cur}` })
      }
    }
    for (const [k, v] of Object.entries(rec)) {
      const child = path === "$" ? `$.${k}` : `${path}.${k}`
      const t = scalarText(v)
      if (t !== null) out.push({ path: child, text: t })
      else walkJsonLd(v, child, out)
    }
    return
  }
  const t = scalarText(node)
  if (t !== null) out.push({ path, text: t })
}

// --- META collection ---------------------------------------------------------

const collectMeta = (html: string): { locator: string; content: string }[] => {
  const $ = load(html)
  const out: { locator: string; content: string }[] = []
  $("meta").each((_i, el) => {
    const content = $(el).attr("content") ?? ""
    if (content.trim() === "") return
    const name = $(el).attr("name") ?? $(el).attr("property") ?? $(el).attr("itemprop") ?? "content"
    out.push({ locator: `meta:${name}`, content })
  })
  return out
}

// --- Visible text ------------------------------------------------------------

const collectVisibleText = (html: string): string => {
  const $ = load(html)
  $("script, style, noscript, template").remove()
  return normalizeVisible($("body").length > 0 ? $("body").text() : $.root().text())
}

const tokenBoundaryRe = (needle: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(needle)}(?![A-Za-z0-9_])`)

const MONEY_CANDIDATE_RE =
  /(?<cur1>[A-Z]{3}|[$€£¥])?\s*(?<num>-?\d+(?:,\d{3})*(?:\.\d+)?)\s*(?<cur2>[A-Z]{3})?/g

const snippetAround = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - 200)
  const end = Math.min(text.length, index + length + 200)
  const raw = text.slice(start, end)
  return raw.length > SNIPPET_MAX ? raw.slice(0, SNIPPET_MAX) : raw
}

const clip = (s: string): string => (s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX) : s)

// --- Main entry ---------------------------------------------------------------

/**
 * Match one page body against a frozen authority snapshot. Deterministic:
 * lineages in snapshot order, current value before historical values,
 * surfaces JSON-LD, META, VISIBLE_TEXT.
 */
export const matchPage = (html: string, snapshot: AuthoritySnapshot): DiscoveryMatchEvent[] => {
  const jsonLd = collectJsonLd(html)
  const metas = collectMeta(html)
  const visible = collectVisibleText(html)
  const events: DiscoveryMatchEvent[] = []

  for (const lineage of snapshot.lineages) {
    const targets = [
      {
        factId: lineage.activeId,
        version: lineage.activeVersion,
        value: lineage.currentValue,
        relation: "CURRENT_VALUE" as const,
      },
      ...[...lineage.historicalValues]
        .sort((a, b) => a.version - b.version)
        .map((h) => ({ factId: h.factId, version: h.version, value: h.value, relation: "HISTORICAL_VALUE" as const })),
    ]
    for (const t of targets) {
      for (const leaf of jsonLd) {
        if (structuredEquals(t.value, lineage.valueType, leaf.text)) {
          events.push({
            lineageRoot: lineage.rootId,
            matchedFact: t.factId,
            matchedVersion: t.version,
            matchedValue: t.value,
            surface: "JSON_LD",
            locator: `json-ld:${leaf.path}`,
            snippet: clip(leaf.text),
            relation: t.relation,
          })
        }
      }
      for (const meta of metas) {
        if (structuredEquals(t.value, lineage.valueType, meta.content)) {
          events.push({
            lineageRoot: lineage.rootId,
            matchedFact: t.factId,
            matchedVersion: t.version,
            matchedValue: t.value,
            surface: "META",
            locator: meta.locator,
            snippet: clip(meta.content),
            relation: t.relation,
          })
        }
      }
      if (lineage.valueType === "BOOLEAN") continue // booleans never from visible prose
      const collapsed = normalizeVisible(t.value)
      if (lineage.valueType === "TEXT") {
        if (collapsed.length < MIN_VISIBLE_TEXT_LENGTH) continue
        const m = tokenBoundaryRe(collapsed).exec(visible)
        if (m !== null && m.index !== undefined) {
          events.push({
            lineageRoot: lineage.rootId,
            matchedFact: t.factId,
            matchedVersion: t.version,
            matchedValue: t.value,
            surface: "VISIBLE_TEXT",
            locator: `visible-text:char-${m.index}`,
            snippet: snippetAround(visible, m.index, m[0].length),
            relation: t.relation,
          })
        }
      } else {
        // CURRENCY: compare money-shaped candidates in the visible text.
        MONEY_CANDIDATE_RE.lastIndex = 0
        let m: RegExpExecArray | null
        let matched = false
        while ((m = MONEY_CANDIDATE_RE.exec(visible)) !== null && !matched) {
          const candidate = (m[0] ?? "").trim()
          if (candidate === "") continue
          if (moneyEqual(t.value, candidate)) {
            events.push({
              lineageRoot: lineage.rootId,
              matchedFact: t.factId,
              matchedVersion: t.version,
              matchedValue: t.value,
              surface: "VISIBLE_TEXT",
              locator: `visible-text:char-${m.index}`,
              snippet: snippetAround(visible, m.index, m[0].length),
              relation: t.relation,
            })
            matched = true
          }
          if (m[0].length === 0) MONEY_CANDIDATE_RE.lastIndex += 1
        }
      }
    }
  }
  return events
}

/** Group match events for one page into per-lineage candidate summaries. */
export const summarizeMatches = (args: {
  readonly pageUrl: string
  readonly pageObservationId: string
  readonly runId: string
  readonly events: ReadonlyArray<DiscoveryMatchEvent>
}): CandidateSummary[] => {
  const byRoot = new Map<string, DiscoveryMatchEvent[]>()
  for (const e of args.events) {
    const list = byRoot.get(e.lineageRoot) ?? []
    list.push(e)
    byRoot.set(e.lineageRoot, list)
  }
  const summaries: CandidateSummary[] = []
  for (const [root, list] of [...byRoot.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const toMatch = (e: DiscoveryMatchEvent): DiscoveryMatch => ({
      run_id: args.runId,
      page_observation_id: args.pageObservationId,
      lineage_root: e.lineageRoot,
      matched_fact: e.matchedFact,
      matched_version: e.matchedVersion,
      matched_value: e.matchedValue,
      surface: e.surface,
      locator: e.locator,
      snippet: e.snippet,
      relation: e.relation,
      matcher_version: MATCHER_VERSION,
    })
    const current = list.filter((e) => e.relation === "CURRENT_VALUE").map(toMatch)
    const historical = list.filter((e) => e.relation === "HISTORICAL_VALUE").map(toMatch)
    const state = current.length > 0 && historical.length > 0 ? "MIXED_KNOWN_VALUES" : current.length > 0 ? "CURRENT_VALUE_FOUND" : "HISTORICAL_VALUE_FOUND"
    summaries.push({
      page_url: args.pageUrl,
      lineage_root: root,
      state,
      current_match: current[0] ?? null,
      historical_matches: historical,
    })
  }
  return summaries
}

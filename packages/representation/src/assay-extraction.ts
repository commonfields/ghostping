import { load } from "cheerio"
import { ASSAY_MAX_SPAN, ASSAY_MAX_TEXT, compareMoneyClaim, parseMoneyFact, priceMentionCount, type ClaimComparison, type MoneyFact } from "./assay.js"

export const ASSAY_EXTRACTOR_VERSION = "assay-deterministic-v2"
export type AssayFactType = "PRICE" | "PLAN_AVAILABILITY" | "BOOLEAN_CAPABILITY"
export interface BooleanAssayFact { readonly value: boolean; readonly qualifier: "EXACT" | "UNKNOWN" }
export type AssayNormalized = MoneyFact | BooleanAssayFact
export interface ProposedAssayFact {
  readonly factType: AssayFactType
  readonly subject: string
  readonly normalized: AssayNormalized
  readonly supportingSpan: string
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const mentions = (text: string, subject: string) => subject.trim().length > 0 && new RegExp(`\\b${escape(subject)}\\b`, "i").test(text)
const sentences = (text: string): string[] => {
  const spans: string[] = []
  let start = 0
  for (let i = 0; i < Math.min(text.length, ASSAY_MAX_TEXT); i++) {
    if (text[i] === "\n" || (/[.!?]/.test(text[i]!) && (i === text.length - 1 || /\s/.test(text[i + 1]!)))) {
      const span = text.slice(start, i + 1).trim()
      if (span) spans.push(span)
      start = i + 1
    }
  }
  const last = text.slice(start, ASSAY_MAX_TEXT).trim()
  if (last) spans.push(last)
  return spans
}
// Deliberately narrow: these assertions cannot establish unconditional current truth.
const DOUBTFUL_BASE = /\b(while|whereas|unlike|but|however|than|versus|vs|compared|except|other|competitors?|no longer|formerly|previously|used to|was|were|dropped|deprecated|discontinued|never|coming soon|in 20\d\d|may|might|perhaps|possibly|uncertain|if|sometimes|only|outside|for enterprise|in (?:the )?(?:Europe|US|USA|UK|EU|United States|Asia)|estimate|approximately|about)\b/i
// Answers are model prose: add hedges, trials and future/conditional wording that a
// pricing card legitimately contains ("14-day free trial") but an answer must not lean on.
const DOUBTFUL = new RegExp(DOUBTFUL_BASE.source.replace(/\)\\b$/, "|roughly|around|nearly|almost|circa|typically|usually|generally|often|average|free|trial|freemium|then|after|until|unless|depends?|varies|vary|will|would|could|should|soon|beta|alpha|preview|planned|upcoming|roadmap|via|through|using)\\b"), "i")
// Common sentence openers are not organisation names; anything else
// capitalised beyond the business and the term is treated as one.
const SAFE_CAPITALS = new Set(["The", "This", "It", "Its", "A", "An", "Yes", "No", "Currently", "Today", "Also", "Starting", "Starts", "From", "Flat", "Per", "Plan", "Monthly", "Annual", "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "NZD", "CHF", "CNY", "INR", "SGD", "HKD"])
const guarded = (text: string, subject: string, aliases: readonly string[], requireBusiness = true): boolean => {
  if (text.length > ASSAY_MAX_SPAN || DOUBTFUL.test(text)) return false
  if (requireBusiness && !aliases.some(a => mentions(text, a))) return false
  let remaining = text
  for (const alias of [...aliases, subject].sort((a, b) => b.length - a.length)) remaining = remaining.replace(new RegExp(`\\b${escape(alias)}\\b`, "gi"), "")
  // A second capitalised name could be another organisation. False negatives
  // are preferable to crediting another company's statement to the prospect.
  return !(remaining.match(/\b[A-Z][A-Za-z0-9]+\b/g) ?? []).some(word => !SAFE_CAPITALS.has(word))
}
const booleanClaim = (subject: string, text: string, kind: "plan" | "capability", aliases: readonly string[]): boolean | null => {
  if (!guarded(text, subject, aliases)) return null
  const term = escape(subject)
  const yes = kind === "plan"
    ? new RegExp(`\\b${term}(?: (?:plan|tier))? (?:is |remains )?(?:available|offered)\\b`, "i")
    : new RegExp(`\\b(?:supports?|integrates? with|includes?) ${term}\\b|\\b${term}(?: integration)? is (?:supported|available)\\b`, "i")
  const no = kind === "plan"
    ? new RegExp(`\\b${term}(?: (?:plan|tier))? (?:is )?(?:not available|unavailable)\\b|\\b(?:has no|does not offer) ${term}(?: (?:plan|tier))?\\b`, "i")
    : new RegExp(`\\b(?:does not|doesn't|cannot|can't) (?:support|integrate with|include) ${term}\\b|\\b${term}(?: integration)? is (?:not supported|unavailable)\\b`, "i")
  const negative = no.test(text)
  const positive = yes.test(text.replace(no, ""))
  return positive === negative ? null : positive
}
export const comparePlanAvailabilityClaim = (fact: BooleanAssayFact, subject: string, answer: string, aliases: readonly string[] = []): ClaimComparison => compareBoolean(fact, subject, answer, "plan", aliases)
export const compareBooleanCapabilityClaim = (fact: BooleanAssayFact, subject: string, answer: string, aliases: readonly string[] = []): ClaimComparison => compareBoolean(fact, subject, answer, "capability", aliases)
const compareBoolean = (fact: BooleanAssayFact, subject: string, answer: string, kind: "plan" | "capability", aliases: readonly string[]): ClaimComparison => {
  if (answer.length > ASSAY_MAX_SPAN) return "UNCLEAR"
  const relevant = sentences(answer).filter(s => mentions(s, subject))
  if (!relevant.length) return "NOT_MENTIONED"
  const values = relevant.map(s => booleanClaim(subject, s, kind, aliases))
  if (fact.qualifier !== "EXACT" || values.some(v => v === null) || new Set(values).size !== 1) return "UNCLEAR"
  return values[0] === fact.value ? "MATCHES" : "CONTRADICTS"
}
// requireBusiness: an answer about a plan ("Pro") must also name the business;
// "Pro plans typically cost $99" says nothing about this prospect.
const priceScope = (text: string, subject: string, aliases: readonly string[], planTerms: readonly string[], requireBusiness = false) => {
  if (!guarded(text, subject, aliases, requireBusiness) || /\b(?:not|never|no|neither|nor|without)\b|n['’]t\b/i.test(text)) return false
  // An unscoped business price cannot be compared with a named tier price.
  const otherPlans = planTerms.filter(p => !mentions(subject, p))
  return !otherPlans.some(p => mentions(text, p)) && !/\b(?:[\w-]+\s+)(?:plan|tier)\b/i.test(text.replace(new RegExp(`\\b${escape(subject)}(?: (?:plan|tier))?\\b`, "gi"), ""))
}
interface DomNode { readonly type: string; readonly name?: string; readonly data?: string; readonly children?: readonly DomNode[] }
const BLOCK_TAGS = new Set(["p", "div", "li", "tr", "section", "article"])
const normalize = (text: string) => text.replace(/[\t \r]+/g, " ").trim()
// One iterative post-order pass: each block's text is assembled from its
// children only while it stays within ASSAY_MAX_SPAN, so nesting depth and
// page size cannot make block selection quadratic or overflow the stack.
const smallBlocks = (body: DomNode | undefined): string[] => {
  if (!body) return []
  const blocks: string[] = []
  const text = new Map<DomNode, string | null>()
  const stack: Array<[DomNode, boolean]> = [[body, false]]
  while (stack.length) {
    const [node, visited] = stack.pop()!
    if (node.type === "text") { text.set(node, (node.data ?? "").length <= ASSAY_MAX_SPAN ? node.data ?? "" : null); continue }
    if (!node.children) { text.set(node, ""); continue }
    if (!visited) { stack.push([node, true]); for (const child of node.children) stack.push([child, false]); continue }
    let joined: string | null = ""
    for (const child of node.children) {
      const part = text.get(child)
      joined = part === null || part === undefined || joined.length + part.length > ASSAY_MAX_SPAN ? null : joined + part
      if (joined === null) break
    }
    for (const child of node.children) text.delete(child)
    text.set(node, joined)
    if (joined !== null && node.name && BLOCK_TAGS.has(node.name)) blocks.push(normalize(joined))
  }
  return blocks
}
// A plan card is the operator-named plan's own smallest block, so feature
// names inside it are expected. Any doubt about the basis degrades the
// qualifier to UNKNOWN (never comparable) instead of guessing.
const planCardPrice = (block: string): MoneyFact | null => {
  const whole = parseMoneyFact(block)
  if (!whole) return null
  const line = sentences(block).find(s => priceMentionCount(s) === 1)
  const local = line ? parseMoneyFact(line) : null
  const unsure = DOUBTFUL_BASE.test(block) || /\bnot\b/i.test(block) || whole.billingPeriod === "UNKNOWN" || !local
    || local.billingPeriod !== whole.billingPeriod || local.unit !== whole.unit || local.qualifier !== whole.qualifier
  return unsure ? { ...whole, qualifier: "UNKNOWN" } : whole
}
// The HTML parser is super-linear on pathological nesting and the text walk
// recurses, so a hostile page could stall or crash the worker. A linear
// pre-scan refuses pages nested deeper than any real pricing page.
export const ASSAY_MAX_NESTING = 512
const UNNESTED = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
  "p", "li", "dt", "dd", "td", "th", "tr", "tbody", "thead", "tfoot", "option", "optgroup", "colgroup", "rt", "rp", "html", "head", "body"])
const tooDeep = (html: string): boolean => {
  let depth = 0
  for (let i = html.indexOf("<"); i !== -1; i = html.indexOf("<", i + 1)) {
    const closing = html[i + 1] === "/"
    let j = i + (closing ? 2 : 1)
    let name = ""
    while (j < html.length && name.length < 16 && /[A-Za-z0-9-]/.test(html[j]!)) name += html[j++]!
    if (!/^[A-Za-z]/.test(name)) continue
    const end = html.indexOf(">", j)
    if (end === -1) return false
    i = end
    if (UNNESTED.has(name.toLowerCase())) continue
    if (closing) depth = Math.max(0, depth - 1)
    else if (html[end - 1] !== "/" && ++depth > ASSAY_MAX_NESTING) return true
  }
  return false
}
// Linear tag strip for evidence text when the page is refused for parsing.
const stripTags = (html: string): string => {
  let out = ""
  let i = 0
  while (i < html.length) {
    const open = html.indexOf("<", i)
    if (open === -1) { out += html.slice(i); break }
    out += html.slice(i, open) + " "
    const close = html.indexOf(">", open)
    if (close === -1) break
    i = close + 1
  }
  return normalize(out)
}
export const proposeAssayFacts = (html: string, input: { subject: string; businessName?: string; planTerms: readonly string[]; capabilityTerms: readonly string[] }) => {
  if (html.length > ASSAY_MAX_TEXT || tooDeep(html)) return { text: stripTags(html.slice(0, ASSAY_MAX_TEXT)), facts: [] as ProposedAssayFact[] }
  const $ = load(html)
  $("script,style,noscript,template").remove()
  $("br,p,div,li,tr,h1,h2,h3,h4,section,article").each((_, el) => { $(el).append("\n") })
  const text = normalize($("body").text())
  const spans = sentences(text)
  const facts: ProposedAssayFact[] = []
  const aliases = [input.subject, ...(input.businessName ? [input.businessName] : [])]
  // Business-level price: the page must state exactly one price at all.
  const prices = spans.filter(s => priceMentionCount(s) > 0)
  const only = prices.length === 1 ? prices[0]! : null
  if (only && mentions(only, input.subject) && priceMentionCount(only) === 1 && priceScope(only, input.subject, aliases, input.planTerms)) {
    const price = parseMoneyFact(only)
    if (price) facts.push({ factType: "PRICE", subject: input.subject, normalized: price.billingPeriod === "UNKNOWN" ? { ...price, qualifier: "UNKNOWN" } : price, supportingSpan: only })
  }
  // Plan-scoped price: the smallest DOM block naming exactly this plan and
  // exactly one price. Never join a plan header to a sibling block's price.
  const blocks = input.planTerms.length ? smallBlocks($("body")[0] as unknown as DomNode | undefined) : []
  for (const plan of input.planTerms) {
    if (facts.some(f => f.factType === "PRICE" && f.subject === plan)) continue
    const card = blocks.filter(block => mentions(block, plan) && priceMentionCount(block) === 1 && !input.planTerms.some(other => other !== plan && mentions(block, other)))
      .sort((a, b) => a.length - b.length)[0]
    const price = card ? planCardPrice(card) : null
    if (card && price) facts.push({ factType: "PRICE", subject: plan, normalized: price, supportingSpan: card })
  }
  for (const [kind, terms] of [["plan", input.planTerms], ["capability", input.capabilityTerms]] as const) {
    for (const subject of terms) {
      const relevant = spans.filter(s => mentions(s, subject))
      if (!relevant.length) continue
      const values = relevant.map(s => booleanClaim(subject, s, kind, aliases))
      if (values.some(v => v === null) || new Set(values).size !== 1) continue
      facts.push({ factType: kind === "plan" ? "PLAN_AVAILABILITY" : "BOOLEAN_CAPABILITY", subject, normalized: { value: values[0]!, qualifier: "EXACT" }, supportingSpan: relevant[0]! })
    }
  }
  return { text, facts }
}
export const extractAssayJudgment = (fact: { factType: AssayFactType; subject: string; normalized: AssayNormalized; businessAliases?: readonly string[]; planTerms?: readonly string[] }, answer: string) => {
  const aliases = fact.businessAliases ?? [fact.subject]
  const relevant = answer.length <= ASSAY_MAX_SPAN ? sentences(answer).filter(s => mentions(s, fact.subject)) : []
  // Even NOT_MENTIONED/UNCLEAR judgments preserve a nonempty exact substring.
  const span = (relevant.length === 1 ? relevant[0]! : answer).slice(0, ASSAY_MAX_SPAN)
  let comparison: ClaimComparison
  if (answer.length > ASSAY_MAX_SPAN) comparison = "UNCLEAR"
  else if (fact.factType === "PRICE") {
    if (!priceMentionCount(answer)) comparison = "NOT_MENTIONED"
    else if (relevant.length !== 1 || priceMentionCount(answer) !== 1 || !priceScope(span, fact.subject, aliases, fact.planTerms ?? [], !aliases.some(a => a.toLowerCase() === fact.subject.toLowerCase()))) comparison = "UNCLEAR"
    else if (!parseMoneyFact(span)) comparison = "UNCLEAR"
    else comparison = compareMoneyClaim(fact.normalized as MoneyFact, span)
  } else comparison = compareBoolean(fact.normalized as BooleanAssayFact, fact.subject, answer, fact.factType === "PLAN_AVAILABILITY" ? "plan" : "capability", aliases)
  return { comparison, supportingSpan: span, structuredOutput: { parsedMoney: fact.factType === "PRICE" ? parseMoneyFact(span) : null } }
}
export const retrievalClassification = (modes: readonly string[], synthetic = false) => {
  if (synthetic) return { retrievalClass: "SYNTHETIC_FIXTURE", verificationEligible: false }
  const eligible = modes.length > 0 && modes.every(m => ["WEB_SEARCH", "PROVIDER_GROUNDING", "grounded"].includes(m))
  return { retrievalClass: eligible ? "RETRIEVAL_ENABLED" : modes.every(m => ["NONE", "parametric"].includes(m)) ? "STALE_PARAMETRIC_KNOWLEDGE" : modes.every(m => m === "MANUAL_CAPTURE") ? "MANUAL_CAPTURE" : "UNKNOWN", verificationEligible: eligible }
}

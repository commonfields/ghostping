// Fix proposals: the smallest safe correction per finding kind.
// Conservative by default: substantive copy/schema/robots/canonical changes
// require approval; deterministic mechanical repairs may be automatic.
// Autonomous marketing copy is never generated.
import type { DerivedFinding, FixClassification, FixKind } from "./types.js"

export interface FixProposalDraft {
  readonly fixKind: FixKind
  readonly target: string
  readonly before: string | null
  readonly after: string | null
  readonly patch: string | null
  readonly rationale: string
  readonly risk: string
  readonly classification: FixClassification
  readonly requiresApproval: boolean
}

export const proposeFix = (finding: DerivedFinding): FixProposalDraft | null => {
  switch (finding.findingKind) {
    case "BLOCKED_BY_META": {
      const meta = String((finding.evidence["robotsMeta"] as string | null) ?? '<meta name="robots" content="noindex">')
      return {
        fixKind: "REMOVE_NOINDEX_META",
        target: finding.url,
        before: meta,
        after: meta.replace(/noindex,?\s*/gi, "").trim() || "(robots meta tag removed)",
        patch: null,
        rationale: "The page is blocked from indexing by a robots meta directive. Removing noindex restores indexability.",
        risk: "Low if the noindex was accidental; confirm the page should be public before applying.",
        classification: "APPROVAL_REQUIRED",
        requiresApproval: true,
      }
    }
    case "BROKEN_CANONICAL": {
      return {
        fixKind: "FIX_CANONICAL",
        target: finding.url,
        before: String(finding.evidence["canonical"] ?? ""),
        after: finding.url,
        patch: null,
        rationale: "The canonical tag points to an invalid URL. Pointing it at the page itself restores signal consolidation.",
        risk: "Medium: canonical changes affect how search engines consolidate signals. Review before applying.",
        classification: "APPROVAL_REQUIRED",
        requiresApproval: true,
      }
    }
    case "CANONICALIZED_ELSEWHERE": {
      return {
        fixKind: "FIX_CANONICAL",
        target: finding.url,
        before: String(finding.evidence["canonical"] ?? ""),
        after: finding.url,
        patch: null,
        rationale: "The canonical tag consolidates this page elsewhere. Correct it if unintentional.",
        risk: "Medium: canonical changes affect index consolidation. Review before applying.",
        classification: "APPROVAL_REQUIRED",
        requiresApproval: true,
      }
    }
    case "BROKEN_INTERNAL_LINK": {
      return {
        fixKind: "FIX_INTERNAL_LINK",
        target: finding.url,
        before: String(finding.evidence["to"] ?? finding.evidence["brokenTo"] ?? ""),
        after: null,
        patch: null,
        rationale: "An internal link points to a missing page. Update it to the closest live replacement.",
        risk: "Low when the replacement is unambiguous; otherwise manual review is required.",
        classification: "APPROVAL_REQUIRED",
        requiresApproval: true,
      }
    }
    case "SITEMAP_INVALID": {
      return {
        fixKind: "REPAIR_SITEMAP",
        target: finding.url,
        before: null,
        after: null,
        patch: null,
        rationale: "The sitemap cannot be parsed. Repairing its XML restores discovery.",
        risk: "Low: deterministic XML repair with no content changes.",
        classification: "SAFE_AUTOMATIC",
        requiresApproval: false,
      }
    }
    case "MISSING_TITLE":
    case "MISSING_DESCRIPTION":
    case "MISSING_ALT":
    case "INVALID_STRUCTURED_DATA":
    case "BLOCKED_BY_ROBOTS":
    case "BLOCKED_BY_HEADER":
    case "NOT_FOUND":
    case "SERVER_ERROR":
    case "REDIRECT_LOOP":
    case "REDIRECT_CHAIN_LONG":
    case "POSSIBLE_ORPHAN":
    case "MISSING_H1":
    case "SITEMAP_MISSING":
    case "RENDER_DISCREPANCY":
    case "ROBOTS_BLOCKS_IMPORTANT":
      return {
        fixKind: "MANUAL_ONLY",
        target: finding.url,
        before: null,
        after: null,
        patch: null,
        rationale: manualRationale(finding.findingKind),
        risk: "Manual review required: the correction depends on site intent or content judgment.",
        classification: "MANUAL_ONLY",
        requiresApproval: true,
      }
  }
}

const manualRationale = (kind: string): string => {
  switch (kind) {
    case "MISSING_TITLE":
      return "A title rewrite needs human judgment about the page topic; OpenRecord does not autonomously publish marketing copy."
    case "MISSING_DESCRIPTION":
      return "A meta description is presentation copy; it needs human approval before publishing."
    case "INVALID_STRUCTURED_DATA":
      return "Schema changes affect search presentation and need human review."
    case "BLOCKED_BY_ROBOTS":
    case "ROBOTS_BLOCKS_IMPORTANT":
      return "robots.txt changes affect the whole site crawl; they need human approval."
    default:
      return "This finding needs a human decision before any site change."
  }
}

/** Build a minimal unified diff for before/after file content. */
export const buildPatch = (filePath: string, before: string, after: string): string => {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const out: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`]
  const n = Math.max(beforeLines.length, afterLines.length)
  for (let i = 0; i < n; i++) {
    const b = beforeLines[i]
    const a = afterLines[i]
    if (b === a) {
      if (b !== undefined) out.push(` ${b}`)
    } else {
      if (b !== undefined) out.push(`-${b}`)
      if (a !== undefined) out.push(`+${a}`)
    }
  }
  return out.join("\n")
}

/** Attempt a mechanical noindex removal on raw HTML. Returns null when unsafe. */
export const removeNoindexFromHtml = (html: string): string | null => {
  // Only handle the exact accidental-noindex shape: a robots meta tag whose
  // content includes noindex. Anything else is MANUAL_ONLY (never guess).
  const re = /<meta\s+[^>]*name=["']robots["'][^>]*>/i
  const m = html.match(re)
  if (!m) return null
  const tag = m[0]
  if (!/noindex/i.test(tag)) return null
  const contentMatch = tag.match(/content=["']([^"']*)["']/i)
  if (!contentMatch) return null
  const parts = contentMatch[1]!.split(",").map((s) => s.trim()).filter((s) => s.toLowerCase() !== "noindex" && s !== "")
  const nextTag = parts.length === 0 ? "" : tag.replace(contentMatch[0], `content="${parts.join(", ")}"`)
  return html.replace(tag, nextTag)
}

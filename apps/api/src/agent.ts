// Agent assistance V1: deterministic, read-only answers over existing repos.
//
// No LLM, no autonomous writes. The message is untrusted operator input;
// the reply cites only rows the server read under the session account.
// Anything that would write (run check, discovery run, intervention,
// recheck, packet export bytes) is returned as a plan with a UI deep link
// the human clicks. Publishing stays manual by design.
import { Effect } from "effect"
import {
  BusinessRepository,
  DiscoveryScopeRepository,
  FactRepository,
  ProductReadRepository,
  QuestionRepository,
} from "@ghostping/db"
import { issueStateOf, loadRepresentations } from "./reads.js"
import { loadDiscoveryScopes } from "./discovery-reads.js"

export interface AgentToolCall {
  readonly tool: string
  readonly summary: string
}

export interface AgentCitation {
  readonly kind: string
  readonly id: string
  readonly text: string
}

export interface AgentReply {
  readonly reply: string
  readonly toolCalls: ReadonlyArray<AgentToolCall>
  readonly citations: ReadonlyArray<AgentCitation>
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

const has = (message: string, ...words: Array<string>): boolean => {
  const lower = message.toLowerCase()
  return words.some((w) => lower.includes(w))
}

const take = <T>(rows: ReadonlyArray<T>, n: number): Array<T> => rows.slice(0, n)

export const handleAgentMessage = (
  accountId: string,
  businessId: string,
  message: string,
): Effect.Effect<
  AgentReply,
  unknown,
  BusinessRepository | FactRepository | QuestionRepository | ProductReadRepository | DiscoveryScopeRepository
> =>
  Effect.gen(function*() {
    const biz = yield* BusinessRepository
    if (!(yield* biz.getScoped(accountId, businessId))) {
      return {
        reply: "That business was not found in your account, so I cannot read its evidence.",
        toolCalls: [],
        citations: [],
      } satisfies AgentReply
    }

    const clean = message.trim().slice(0, 4000)
    const ids = Array.from(new Set((clean.match(UUID_RE) ?? []).map((s) => s.toLowerCase())))
    const toolCalls: Array<AgentToolCall> = []
    const citations: Array<AgentCitation> = []
    const lines: Array<string> = []

    const facts = yield* FactRepository
    const questions = yield* QuestionRepository
    const reads = yield* ProductReadRepository

    const factRows = yield* facts.listByBusiness(businessId)
    const questionRows = yield* questions.listByBusiness(businessId)
    const issueRows = yield* reads.issueList(businessId)
    const representations = (yield* loadRepresentations(accountId, businessId)) ?? []
    const scopes = (yield* loadDiscoveryScopes(accountId, businessId)) ?? []

    toolCalls.push({ tool: "read_business_truth", summary: `${factRows.length} approved facts read` })
    toolCalls.push({ tool: "discover_buyer_questions", summary: `${questionRows.length} buyer questions read` })
    toolCalls.push({ tool: "audit_page_answerability", summary: `${representations.length} tracked representations read` })

    const activeFacts = factRows.filter((f) => (f as { status: string }).status === "ACTIVE")
    const withState = issueRows.map((r) => ({
      row: r,
      state: issueStateOf((r["verdict"] as string | null) ?? null),
    }))
    const openIssues = withState.filter((i) => i.state !== "RESOLVED")

    // GSC / broad-SEO boundary: CLI-only, never hosted. Say so plainly.
    if (has(clean, "search console", "gsc", "keyword", "competitor", "backlink", "crawl the web", "google seo", "semrush", "ahrefs")) {
      return {
        reply: [
          "Search Console evidence and broad SEO tooling live in the local Rust CLI, not in this hosted workspace.",
          "Import a Search Console CSV with: ghostping observations import-gsc --file Queries.csv --date YYYY-MM-DD.",
          "Competitor monitoring, keyword discovery, and content generation are CLI capabilities; the hosted Agent cannot run them. What it can do is trace an AI misrepresentation to your approved facts and tracked sources below.",
        ].join(" "),
        toolCalls: [{ tool: "import_search_console_evidence", summary: "boundary answered: CLI-only, no hosted write" }],
        citations: [],
      } satisfies AgentReply
    }

    if (has(clean, "truth", "fact", "approve", "correct value", "pricing", "price")) {
      const top = take(activeFacts, 5)
      lines.push(`Approved truth: ${activeFacts.length} active facts.`)
      for (const f of top) {
        const row = f as { id: string; predicate: string; valueText: string; version: number }
        lines.push(`- ${row.predicate}: ${row.valueText} (v${row.version})`)
        citations.push({ kind: "fact", id: row.id, text: `${row.predicate}: ${row.valueText}` })
      }
      if (activeFacts.length > top.length) lines.push(`…and ${activeFacts.length - top.length} more on the Truth page.`)
    }

    if (has(clean, "question", "ask", "buyer", "prompt")) {
      const top = take(questionRows, 5)
      lines.push(`Buyer questions: ${questionRows.length} tracked.`)
      for (const q of top) {
        const row = q as { id: string; prompt: string; label: string | null }
        lines.push(`- ${row.label ?? row.prompt.slice(0, 80)}`)
        citations.push({ kind: "question", id: row.id, text: row.prompt })
      }
      if (questionRows.length === 0) lines.push("Add the first question on the Checks page, then run a check to collect evidence.")
    }

    if (has(clean, "issue", "wrong", "incorrect", "outdated", "misrepresent", "contradict", "partial", "inbox")) {
      lines.push(`Open issues: ${openIssues.length}.`)
      for (const { row, state } of take(openIssues, 5)) {
        const claimId = String(row["claim_id"] ?? row["id"] ?? "")
        const claimText = String(row["claim_text"] ?? "")
        lines.push(`- [${state}] ${claimText.slice(0, 120)}`)
        if (claimId) citations.push({ kind: "issue", id: claimId, text: claimText.slice(0, 140) })
      }
      if (openIssues.length === 0) lines.push("No open issues. Run a check, transcribe the claim, and ask a reviewer to judge it.")
    }

    if (has(clean, "source", "representation", "track", "drift", "sync", "verify", "citation")) {
      const drift = representations.filter((r) => r.finding.state === "DRIFT").length
      const unknown = representations.filter((r) => r.finding.state === "UNKNOWN").length
      lines.push(`Tracked sources: ${representations.length} (${drift} drift, ${unknown} unknown).`)
      for (const r of take(representations, 5)) {
        lines.push(`- ${r.fact.predicate}: ${r.finding.state} — ${r.source.control} ${r.source.url.slice(0, 60)}`)
        citations.push({ kind: "representation", id: r.binding_id, text: `${r.fact.predicate} ${r.finding.state}` })
      }
      toolCalls.push({ tool: "explain_representation_issue", summary: "representation findings summarized with citations" })
    }

    if (has(clean, "discover", "crawl", "site", "owned", "sitemap", "robots")) {
      lines.push(`Owned-site discovery: ${scopes.length} scopes.`)
      for (const s of take(scopes, 5)) {
        const row = s as { id: string; rootUrl: string }
        lines.push(`- ${row.rootUrl}`)
        citations.push({ kind: "discovery_scope", id: row.id, text: row.rootUrl })
      }
      lines.push("Discovery runs are append-only evidence collection. Start one from Representations → Discovery.")
      toolCalls.push({ tool: "crawl_owned_site", summary: "discovery scopes listed; run requires human click" })
    }

    if (has(clean, "fix", "correct", "recommend", "draft", "change", "update the site")) {
      const target = openIssues[0]
      if (target) {
        const claimText = String(target.row["claim_text"] ?? "")
        lines.push(`Draft fix (not applied): reword the controlled source behind “${claimText.slice(0, 100)}” to match approved truth, then record the action by hand on the issue page. Publishing stays manual.`)
        toolCalls.push({ tool: "draft_evidence_linked_fix", summary: "draft only; no source changed" })
      } else {
        lines.push("Draft fix: nothing to draft — there are no open issues. Collect a check first.")
      }
    }

    if (has(clean, "record", "intervention", "action taken", "we fixed")) {
      lines.push("Recorded actions are append-only and human-attested. Open the issue, use “Record action”, pick the type and target URL. I do not record actions on your behalf.")
      toolCalls.push({ tool: "record_intervention", summary: "plan returned; human records in UI" })
    }

    if (has(clean, "recheck", "re-observe", "reobserve", "verify source and", "before/after", "before after", "compare")) {
      lines.push("Verification is two human clicks on the issue page: “Verify source” re-fetches the tracked representation, “Recheck AI” collects a fresh answer. The before/after view below compares them and always leaves causal attribution unknown.")
      toolCalls.push({ tool: "verify_source_and_reobserve", summary: "plan returned; human clicks Verify + Recheck" })
    }

    if (has(clean, "packet", "export", "download", "report", "evidence pack")) {
      if (ids.length > 0) {
        lines.push(`Evidence packet: open the issue ${ids[0]} and use “Download packet (JSON)”. The digest verifies the bytes.`)
      } else {
        lines.push("Evidence packet: open any issue and use “Download packet (JSON)”. The digest verifies the bytes.")
      }
      toolCalls.push({ tool: "export_evidence_report", summary: "packet download pointed at issue UI" })
    }

    if (has(clean, "check", "run", "observe", "9router", "model", "live")) {
      const scope = yield* DiscoveryScopeRepository
      void scope
      lines.push("AI checks are append-only evidence. On the Checks page pick Mock (tests) or 9Router with a configured model, run a buyer question, and review the answer. Failed PROVIDER_UNSUPPORTED runs mean no model was configured.")
      toolCalls.push({ tool: "run_ai_answer_checks", summary: "guidance returned; run requires human click" })
    }

    if (lines.length === 0) {
      lines.push(
        `Overview for this business: ${activeFacts.length} active facts, ${questionRows.length} buyer questions, ${openIssues.length} open issues, ${representations.length} tracked representations, ${scopes.length} discovery scopes.`,
      )
      lines.push("Ask me to explain an issue, summarize truth, list buyer questions, review tracked sources, or draft an evidence-linked fix. I read evidence and cite it; I never publish or change verdicts.")
      for (const { row } of take(openIssues, 3)) {
        const claimId = String(row["claim_id"] ?? row["id"] ?? "")
        const claimText = String(row["claim_text"] ?? "")
        if (claimId) citations.push({ kind: "issue", id: claimId, text: claimText.slice(0, 140) })
      }
    }

    return { reply: lines.join("\n"), toolCalls, citations } satisfies AgentReply
  })

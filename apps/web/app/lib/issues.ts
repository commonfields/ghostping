// Issue inbox query model, shared by the list (filters, grouping) and the
// detail page (position in the queue, previous/next). All state lives in the
// URL so a filtered queue survives navigation and can be linked.
import type { IssueState, IssueWithEvidence } from "./api"

export type IssueFilter = "ALL" | IssueState
export type IssueView = "claims" | "answers"
export type IssueSort = "recent" | "frequent" | "oldest"

export const issueFilters: IssueFilter[] = ["ALL", "NEEDS_REVIEW", "WRONG", "PARTIAL", "UNKNOWN"]

// Most severe first: a recurring claim takes the worst verdict it has received.
export const severity: Record<IssueState, number> = { WRONG: 0, PARTIAL: 1, UNKNOWN: 2, NEEDS_REVIEW: 3 }

export type IssueQuery = {
  view: IssueView
  state: IssueFilter
  q: string
  provider: string
  fact: string
  sort: IssueSort
}

export function readIssueQuery(params: URLSearchParams): IssueQuery {
  const view: IssueView = params.get("view") === "answers" ? "answers" : "claims"
  const rawState = params.get("state") as IssueFilter | null
  const rawSort = params.get("sort") as IssueSort | null
  return {
    view,
    state: rawState && issueFilters.includes(rawState) ? rawState : "ALL",
    q: params.get("q") ?? "",
    provider: params.get("provider") ?? "all",
    fact: params.get("fact") ?? "all",
    sort: rawSort === "recent" || rawSort === "frequent" || rawSort === "oldest" ? rawSort : view === "claims" ? "frequent" : "recent",
  }
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")

/** Everything except the state filter, so state counts reflect the other filters. */
export function matchesQuery(i: IssueWithEvidence, q: IssueQuery): boolean {
  if (q.provider !== "all" && i.provider !== q.provider) return false
  if (q.fact === "none" && i.facts.length > 0) return false
  if (q.fact !== "all" && q.fact !== "none" && !i.facts.some((f) => f.predicate === q.fact)) return false
  if (q.q) {
    const needle = norm(q.q)
    const hay = norm(`${i.claim_text} ${i.question_prompt ?? ""} ${i.observed_model ?? ""} ${i.facts.map((f) => `${f.predicate} ${f.valueText}`).join(" ")}`)
    if (!hay.includes(needle)) return false
  }
  return true
}

export function filterIssues(issues: IssueWithEvidence[], q: IssueQuery): IssueWithEvidence[] {
  return issues.filter((i) => matchesQuery(i, q) && (q.state === "ALL" || i.state === q.state))
}

const time = (iso: string) => new Date(iso).getTime()

export function sortAnswers(list: IssueWithEvidence[], sort: IssueSort): IssueWithEvidence[] {
  const out = [...list]
  out.sort((a, b) => (sort === "oldest" ? time(a.collected_at) - time(b.collected_at) : time(b.collected_at) - time(a.collected_at)))
  return out
}

export type ClaimGroup = {
  key: string
  text: string
  state: IssueState
  occurrences: IssueWithEvidence[]
  stateCounts: Record<IssueState, number>
  providers: string[]
  questions: string[]
  facts: IssueWithEvidence["facts"]
  firstSeen: string
  lastSeen: string
  latest: IssueWithEvidence
  citations: number
}

/** One row per distinct claim: the same sentence repeated across models and days is one problem. */
export function groupClaims(list: IssueWithEvidence[], sort: IssueSort): ClaimGroup[] {
  const map = new Map<string, IssueWithEvidence[]>()
  for (const i of list) {
    const k = norm(i.claim_text)
    const bucket = map.get(k)
    if (bucket) bucket.push(i)
    else map.set(k, [i])
  }
  const groups: ClaimGroup[] = [...map.entries()].map(([key, occ]) => {
    const sorted = [...occ].sort((a, b) => time(b.collected_at) - time(a.collected_at))
    const stateCounts: Record<IssueState, number> = { WRONG: 0, PARTIAL: 0, UNKNOWN: 0, NEEDS_REVIEW: 0 }
    for (const o of occ) stateCounts[o.state] += 1
    const reviewedStates = (Object.keys(stateCounts) as IssueState[]).filter((s) => s !== "NEEDS_REVIEW" && stateCounts[s] > 0)
    const state = reviewedStates.sort((a, b) => severity[a] - severity[b])[0] ?? "NEEDS_REVIEW"
    const facts = new Map<string, IssueWithEvidence["facts"][number]>()
    for (const o of sorted) for (const f of o.facts) if (!facts.has(f.id)) facts.set(f.id, f)
    const providerCounts = new Map<string, number>()
    for (const o of occ) providerCounts.set(o.provider, (providerCounts.get(o.provider) ?? 0) + 1)
    return {
      key,
      text: sorted[0]!.claim_text,
      state,
      occurrences: sorted,
      stateCounts,
      providers: [...providerCounts.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p),
      questions: [...new Set(sorted.map((o) => o.question_prompt).filter((p): p is string => !!p))],
      facts: [...facts.values()],
      firstSeen: sorted.at(-1)!.collected_at,
      lastSeen: sorted[0]!.collected_at,
      latest: sorted[0]!,
      citations: occ.reduce((n, o) => n + o.citation_evidence.length, 0),
    }
  })
  groups.sort((a, b) => {
    if (sort === "frequent") return b.occurrences.length - a.occurrences.length || time(b.lastSeen) - time(a.lastSeen)
    if (sort === "oldest") return time(a.firstSeen) - time(b.firstSeen)
    return time(b.lastSeen) - time(a.lastSeen)
  })
  return groups
}

/** Weekly occurrence counts over the span of the whole inbox, oldest first. */
export function weeklyCounts(occ: IssueWithEvidence[], from: number, to: number, buckets = 10): number[] {
  const span = Math.max(1, to - from)
  const out = Array.from({ length: buckets }, () => 0)
  for (const o of occ) {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(((time(o.collected_at) - from) / span) * buckets)))
    out[idx]! += 1
  }
  return out
}

/** Where an occurrence is worked on: unreviewed claims open the answer to judge, reviewed ones open the issue. */
export function occurrenceHref(businessId: string, i: Pick<IssueWithEvidence, "state" | "claim_id" | "observation_id">, search = ""): string {
  return i.state === "NEEDS_REVIEW"
    ? `/observations/${i.observation_id}?claim=${i.claim_id}`
    : `/businesses/${businessId}/issues/${i.claim_id}${search}`
}

export function issuesCsv(list: IssueWithEvidence[]): string {
  const esc = (v: string | null | undefined) => `"${(v ?? "").replace(/"/g, '""')}"`
  const header = ["collected_at", "state", "verdict", "provider", "model", "question", "claim", "approved_facts", "citations"]
  const rows = list.map((i) =>
    [
      i.collected_at,
      i.state,
      i.verdict ?? "",
      i.provider,
      esc(i.observed_model),
      esc(i.question_prompt),
      esc(i.claim_text),
      esc(i.facts.map((f) => `${f.predicate}=${f.valueText} (v${f.version})`).join("; ")),
      String(i.citation_evidence.length),
    ].join(","),
  )
  return [header.join(","), ...rows].join("\n")
}

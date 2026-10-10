import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import {
  ArrowRightIcon,
  BookCheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  InboxIcon,
  LinkIcon,
  MessageSquareQuoteIcon,
  PenLineIcon,
  RadarIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Sparkline } from "@/components/charts"
import { EmptyState, PageHeader, Panel, StatStrip, domainOf, type Stat } from "@/components/page"
import { ProviderLogo, providerBrand } from "@/components/provider-logo"
import { IssueStateBadge, issueStateMeta, ProviderChip } from "@/components/status"
import { Issues, type IssueState, type IssueWithEvidence } from "@/lib/api"
import {
  filterIssues,
  groupClaims,
  issueFilters,
  issuesCsv,
  matchesQuery,
  occurrenceHref,
  readIssueQuery,
  sortAnswers,
  weeklyCounts,
  type ClaimGroup,
  type IssueFilter,
} from "@/lib/issues"
import { errorMessage, formatDate, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

const PAGE_SIZE = 25

const stateTone: Record<IssueState, NonNullable<Stat["tone"]>> = { WRONG: "wrong", PARTIAL: "partial", UNKNOWN: "unknown", NEEDS_REVIEW: "review" }

export function IssuesPage() {
  const { id = "" } = useParams()
  const { activeBusiness } = useWorkspace()
  const { data, loading, error, reload } = useApi(`issues:${id}`, () => Issues.list(id))
  const [params, setParams] = useSearchParams()
  const query = readIssueQuery(params)
  const page = Math.max(1, Number(params.get("page")) || 1)

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === "all" || (k === "state" && v === "ALL")) next.delete(k)
      else next.set(k, v)
    }
    if (!("page" in patch)) next.delete("page")
    setParams(next, { replace: true })
  }

  const issues = useMemo(() => data?.issues ?? [], [data])
  const scoped = useMemo(() => issues.filter((i) => matchesQuery(i, query)), [issues, query.q, query.provider, query.fact]) // eslint-disable-line react-hooks/exhaustive-deps
  const visible = useMemo(() => filterIssues(issues, query), [issues, query.q, query.provider, query.fact, query.state]) // eslint-disable-line react-hooks/exhaustive-deps
  const groups = useMemo(() => groupClaims(visible, query.sort), [visible, query.sort])
  const answers = useMemo(() => sortAnswers(visible, query.sort), [visible, query.sort])
  const span = useMemo(() => {
    const times = issues.map((i) => new Date(i.collected_at).getTime())
    return times.length ? { from: Math.min(...times), to: Math.max(...times) } : { from: 0, to: 1 }
  }, [issues])

  const providers = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of issues) m.set(i.provider, (m.get(i.provider) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [issues])
  const facts = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of issues) for (const f of i.facts) m.set(f.predicate, (m.get(f.predicate) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [issues])

  const stats: Stat[] = issueFilters.map((f) => {
    const list = f === "ALL" ? scoped : scoped.filter((i) => i.state === f)
    const distinct = new Set(list.map((i) => i.claim_text.trim().toLowerCase())).size
    return {
      key: f,
      label: f === "ALL" ? "All open" : issueStateMeta[f].label,
      value: loading ? <Skeleton className="h-5 w-10" /> : list.length.toLocaleString(),
      hint: loading ? null : `${distinct} distinct claim${distinct === 1 ? "" : "s"}`,
      ...(f === "ALL" ? {} : { tone: stateTone[f] }),
      active: query.state === f,
      onSelect: () => set({ state: f }),
    }
  })

  const queue = useMemo(() => sortAnswers(scoped.filter((i) => i.state === "NEEDS_REVIEW"), "recent"), [scoped])
  const filtered = query.q !== "" || query.provider !== "all" || query.fact !== "all" || query.state !== "ALL"
  const listSearch = params.toString() ? `?${params.toString()}` : ""

  return (
    <div className="space-y-4 pb-4">
      <PageHeader
        title="Issues"
        description="Claims from AI answers that disagree with your approved facts, or still need a verdict. Supported claims stay out of this inbox."
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={visible.length === 0}
              onClick={() => download(issuesCsv(answers), `openrecord-issues-${slug(activeBusiness?.name ?? "business")}.csv`)}
            >
              <DownloadIcon />
              Export CSV
            </Button>
            <Button asChild size="sm">
              <Link to={`/businesses/${id}/checks`}>
                <RadarIcon />
                Run a check
              </Link>
            </Button>
          </>
        }
      />

      <StatStrip stats={stats} />

      {!loading && queue.length > 0 && query.state !== "NEEDS_REVIEW" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-review/20 bg-review-soft/60 px-4 py-2.5 shadow-(--float-shadow)">
          <PenLineIcon className="size-4 text-review" />
          <p className="min-w-0 flex-1 text-xs">
            <span className="font-medium text-foreground">
              {queue.length} answer{queue.length === 1 ? "" : "s"} still need a verdict.
            </span>{" "}
            <span className="text-muted-foreground">Unreviewed claims are not counted as wrong until someone judges them.</span>
          </p>
          <Button asChild size="sm" variant="outline">
            <Link to={occurrenceHref(id, queue[0]!)}>
              Start reviewing
              <ArrowRightIcon />
            </Link>
          </Button>
        </div>
      ) : null}

      <Panel>
        <Toolbar
          query={query}
          set={set}
          providers={providers}
          facts={facts}
          groupCount={groups.length}
          answerCount={visible.length}
          loading={loading}
        />

        {loading ? (
          <ul className="divide-y">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="space-y-2 px-4 py-3.5">
                <Skeleton className="h-5 w-28 rounded-full" />
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </li>
            ))}
          </ul>
        ) : error && !data ? (
          <div className="p-4">
            <EmptyState
              icon={<TriangleAlertIcon />}
              title="Issues could not load"
              description={errorMessage(error)}
              action={
                <Button variant="outline" size="sm" onClick={() => void reload()}>
                  Try again
                </Button>
              }
            />
          </div>
        ) : issues.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<InboxIcon />}
              title="Inbox is clear"
              description="Nothing disagrees with your approved facts right now. Run another check to keep an eye on new answers."
              action={
                <Button asChild variant="outline" size="sm">
                  <Link to={`/businesses/${id}/checks`}>Go to checks</Link>
                </Button>
              }
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<SearchIcon />}
              title={query.state !== "ALL" && !query.q && query.provider === "all" && query.fact === "all" ? `No issues marked ${issueStateMeta[query.state].label.toLowerCase()}` : "No issues match these filters"}
              description="Loosen a filter or clear them all to see the rest of the inbox."
              action={
                <Button variant="outline" size="sm" onClick={() => set({ q: null, provider: null, fact: null, state: null })}>
                  Clear filters
                </Button>
              }
            />
          </div>
        ) : query.view === "claims" ? (
          <ul className="divide-y">
            {groups.map((g) => (
              <ClaimGroupRow key={g.key} businessId={id} group={g} span={span} search={listSearch} expandAll={groups.length === 1} />
            ))}
          </ul>
        ) : (
          <AnswersTable businessId={id} rows={answers} page={page} onPage={(p) => set({ page: p === 1 ? null : String(p) })} search={listSearch} />
        )}

        {!loading && filtered && visible.length > 0 ? (
          <div className="flex items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground">
            <span>
              Showing {visible.length.toLocaleString()} of {issues.length.toLocaleString()} open answers
            </span>
            <button type="button" className="font-medium text-foreground hover:underline" onClick={() => set({ q: null, provider: null, fact: null, state: null })}>
              Clear filters
            </button>
          </div>
        ) : null}
      </Panel>
    </div>
  )
}

/* ------------------------------------------------------------- Toolbar */

function Toolbar({
  query,
  set,
  providers,
  facts,
  groupCount,
  answerCount,
  loading,
}: {
  query: ReturnType<typeof readIssueQuery>
  set: (patch: Record<string, string | null>) => void
  providers: Array<[string, number]>
  facts: Array<[string, number]>
  groupCount: number
  answerCount: number
  loading: boolean
}) {
  const [text, setText] = useState(query.q)
  const inputRef = useRef<HTMLInputElement>(null)

  // Debounce typing into the URL so every keystroke does not add a history entry.
  useEffect(() => {
    const t = setTimeout(() => {
      if (text !== query.q) set({ q: text || null })
    }, 200)
    return () => clearTimeout(t)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (e.key === "/" && !(target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable))) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2.5">
      <Tabs value={query.view} onValueChange={(v) => set({ view: v === "claims" ? null : v, sort: null })}>
        <TabsList className="h-8">
          <TabsTrigger value="claims" className="px-2.5 text-xs">
            By claim
            <Count n={loading ? null : groupCount} />
          </TabsTrigger>
          <TabsTrigger value="answers" className="px-2.5 text-xs">
            Every answer
            <Count n={loading ? null : answerCount} />
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="relative min-w-[8rem] flex-1">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setText("")
              e.currentTarget.blur()
            }
          }}
          placeholder="Search claims and questions"
          aria-label="Search issues"
          className="h-8 pr-14 pl-8 text-xs"
        />
        {text ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => setText("")}
            className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : (
          <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">/</Kbd>
        )}
      </div>

      <Select value={query.provider} onValueChange={(v) => set({ provider: v })}>
        <SelectTrigger className="h-8 w-[8rem] text-xs" aria-label="Filter by model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All models</SelectItem>
          {providers.map(([p, n]) => (
            <SelectItem key={p} value={p}>
              <ProviderLogo provider={p} className="size-4" />
              {providerBrand(p).label}
              <span className="ml-auto pl-2 text-muted-foreground tabular-nums">{n}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={query.fact} onValueChange={(v) => set({ fact: v })}>
        <SelectTrigger className="h-8 w-[8rem] text-xs" aria-label="Filter by approved fact">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All facts</SelectItem>
          {facts.map(([f, n]) => (
            <SelectItem key={f} value={f}>
              {sentenceCase(f)}
              <span className="ml-auto pl-2 text-muted-foreground tabular-nums">{n}</span>
            </SelectItem>
          ))}
          <SelectItem value="none">No fact linked</SelectItem>
        </SelectContent>
      </Select>

      <Select value={query.sort} onValueChange={(v) => set({ sort: v })}>
        <SelectTrigger className="h-8 w-[7.75rem] text-xs" aria-label="Sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {query.view === "claims" ? <SelectItem value="frequent">Most repeated</SelectItem> : null}
          <SelectItem value="recent">Newest first</SelectItem>
          <SelectItem value="oldest">Oldest first</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}

/* --------------------------------------------------------- Claim groups */

function ClaimGroupRow({
  businessId,
  group: g,
  span,
  search,
  expandAll,
}: {
  businessId: string
  group: ClaimGroup
  span: { from: number; to: number }
  search: string
  expandAll: boolean
}) {
  const [open, setOpen] = useState(expandAll)
  const [showAll, setShowAll] = useState(false)
  const toReview = g.occurrences.filter((o) => o.state === "NEEDS_REVIEW")
  const reviewed = g.occurrences.find((o) => o.state !== "NEEDS_REVIEW") ?? null
  const trend = weeklyCounts(g.occurrences, span.from, span.to)
  const shown = showAll ? g.occurrences : g.occurrences.slice(0, 6)
  const tone = g.state === "WRONG" ? "--chart-wrong" : g.state === "PARTIAL" ? "--chart-partial" : g.state === "UNKNOWN" ? "--chart-unknown" : "--chart-unreviewed"

  return (
    <li className={cn("transition-colors", open && "bg-muted/25")}>
      <div className="grid items-center gap-x-6 gap-y-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto_auto_8rem]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="group/claim flex min-w-0 items-start gap-2.5 text-left outline-none"
        >
          <ChevronDownIcon className={cn("mt-1 size-4 shrink-0 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          <span className="min-w-0 space-y-1.5">
            <span className="flex flex-wrap items-center gap-2">
              <IssueStateBadge state={g.state} />
              {g.state !== "NEEDS_REVIEW" && toReview.length > 0 ? (
                <span className="text-[11px] font-medium text-review">{toReview.length} need review</span>
              ) : null}
              <span className="text-[11px] text-muted-foreground">
                · {g.providers.length} model{g.providers.length === 1 ? "" : "s"}
              </span>
            </span>
            <span className="block text-xs leading-snug font-medium group-hover/claim:underline group-hover/claim:decoration-muted-foreground/40 group-hover/claim:underline-offset-4">
              {g.text}
            </span>
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {g.facts.length > 0 ? (
                g.facts.map((f) => (
                  <span key={f.id} className="inline-flex items-center gap-1">
                    <BookCheckIcon className="size-3" />
                    Approved {sentenceCase(f.predicate).toLowerCase()}
                    <span className="font-medium text-foreground">{f.valueText}</span>
                    <span className="tabular-nums">v{f.version}</span>
                  </span>
                ))
              ) : (
                <span className="inline-flex items-center gap-1">
                  <BookCheckIcon className="size-3" />
                  {reviewed ? "No approved fact linked" : "Not compared yet"}
                </span>
              )}
              {g.questions[0] ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <MessageSquareQuoteIcon className="size-3 shrink-0" />
                  <span className="truncate">&ldquo;{g.questions[0]}&rdquo;</span>
                  {g.questions.length > 1 ? <span className="shrink-0">+{g.questions.length - 1}</span> : null}
                </span>
              ) : null}
              {g.citations > 0 ? (
                <span className="inline-flex items-center gap-1">
                  <LinkIcon className="size-3" />
                  {g.citations} cited source{g.citations === 1 ? "" : "s"}
                </span>
              ) : null}
            </span>
          </span>
        </button>

        <div className="pl-6 md:pl-0">
          <ModelStack providers={g.providers} max={4} />
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex cursor-default items-center gap-2.5 pl-6 md:pl-0">
              <Sparkline values={trend} cssVar={tone} className="w-12" />
              <span className="w-[4.5rem] text-right leading-tight">
                <span className="block text-xs font-semibold tabular-nums">{g.occurrences.length}×</span>
                <span className="block text-[11px] whitespace-nowrap text-muted-foreground">{relativeTime(g.lastSeen)}</span>
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            Seen {g.occurrences.length} times, first {formatDate(g.firstSeen)}, last {formatDateTime(g.lastSeen)}
          </TooltipContent>
        </Tooltip>

        <div className="flex items-center justify-start gap-1 pl-6 md:justify-end md:pl-0">
          {toReview.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button asChild size="sm" className="h-7 gap-1 px-2 text-xs">
                  <Link to={occurrenceHref(businessId, toReview[0]!)} aria-label={`Review claim, ${toReview.length} waiting`}>
                    <PenLineIcon className="size-3.5" />
                    Review
                    <span className="tabular-nums opacity-80">{toReview.length}</span>
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Review claim: {toReview.length} answer{toReview.length === 1 ? "" : "s"} waiting</TooltipContent>
            </Tooltip>
          ) : null}
          {reviewed ? (
            toReview.length > 0 ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button asChild size="icon-sm" variant="ghost" className="size-7">
                    <Link to={`/businesses/${businessId}/issues/${reviewed.claim_id}${search}`} aria-label="View issue">
                      <ChevronRightIcon />
                    </Link>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>View issue</TooltipContent>
              </Tooltip>
            ) : (
              <Button asChild size="sm" variant="outline" className="h-7 px-2.5 text-xs">
                <Link to={`/businesses/${businessId}/issues/${reviewed.claim_id}${search}`}>
                  View issue
                  <ChevronRightIcon className="size-3.5" />
                </Link>
              </Button>
            )
          ) : null}
        </div>
      </div>

      {open ? (
        <div className="pb-3 pl-10 pr-4">
          <ul className="overflow-hidden rounded-lg border bg-card shadow-(--float-shadow)">
            {shown.map((o) => (
              <OccurrenceRow key={o.claim_id} businessId={businessId} issue={o} search={search} />
            ))}
          </ul>
          {g.occurrences.length > shown.length ? (
            <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-[11px] font-medium text-muted-foreground hover:text-foreground">
              Show all {g.occurrences.length} answers
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function OccurrenceRow({ businessId, issue: o, search }: { businessId: string; issue: IssueWithEvidence; search: string }) {
  return (
    <li className="border-b last:border-b-0">
      <Link
        to={occurrenceHref(businessId, o, search)}
        className="grid items-center gap-x-4 gap-y-1 px-3 py-2 text-xs outline-none transition-colors hover:bg-muted/50 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto_auto]"
      >
        <ProviderChip provider={o.provider} model={o.observed_model} />
        <span className="min-w-0 truncate text-muted-foreground">{o.question_prompt ? <>Asked &ldquo;{o.question_prompt}&rdquo;</> : "Question not recorded"}</span>
        <span className="flex items-center gap-2">
          <IssueStateBadge state={o.state} />
          <span className="w-20 text-right whitespace-nowrap text-muted-foreground tabular-nums" title={formatDateTime(o.collected_at)}>
            {relativeTime(o.collected_at)}
          </span>
        </span>
        <span className="flex w-24 items-center justify-end gap-1 font-medium text-foreground">
          {o.state === "NEEDS_REVIEW" ? "Review claim" : "View issue"}
          <ChevronRightIcon className="size-3.5 text-muted-foreground" />
        </span>
      </Link>
    </li>
  )
}

function ModelStack({ providers, max = 5 }: { providers: string[]; max?: number }) {
  const shown = providers.slice(0, max)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex cursor-default items-center -space-x-1">
          {shown.map((p) => (
            <ProviderLogo key={p} provider={p} className="size-5 ring-2 ring-card" />
          ))}
          {providers.length > max ? (
            <span className="flex size-5 items-center justify-center rounded-[5px] bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-card">
              +{providers.length - max}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent>{providers.map((p) => providerBrand(p).label).join(", ")}</TooltipContent>
    </Tooltip>
  )
}

/* -------------------------------------------------------- Every answer */

function AnswersTable({
  businessId,
  rows,
  page,
  onPage,
  search,
}: {
  businessId: string
  rows: IssueWithEvidence[]
  page: number
  onPage: (p: number) => void
  search: string
}) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const slice = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  return (
    <>
      <div className="hidden grid-cols-[9rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_3rem_5rem] gap-x-4 border-b bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground lg:grid">
        <span>State</span>
        <span>AI said</span>
        <span>Your approved fact</span>
        <span>Model</span>
        <span>Sources</span>
        <span className="text-right">Seen</span>
      </div>
      <ul className="divide-y">
        {slice.map((i) => (
          <li key={i.claim_id}>
            <Link
              to={occurrenceHref(businessId, i, search)}
              className="grid items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-xs outline-none transition-colors hover:bg-muted/40 lg:grid-cols-[9rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_3rem_5rem]"
            >
              <span>
                <IssueStateBadge state={i.state} />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{i.claim_text}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {i.question_prompt ? <>Asked &ldquo;{i.question_prompt}&rdquo;</> : "Question not recorded"}
                </span>
              </span>
              <span className="min-w-0 truncate">
                {i.facts.length > 0 ? (
                  i.facts.map((f) => (
                    <span key={f.id} className="mr-2">
                      <span className="text-muted-foreground">{sentenceCase(f.predicate)} </span>
                      <span className="font-medium">{f.valueText}</span> <span className="text-[11px] text-muted-foreground tabular-nums">v{f.version}</span>
                    </span>
                  ))
                ) : (
                  <span className="text-muted-foreground">{i.state === "NEEDS_REVIEW" ? "Not compared yet" : "No fact linked"}</span>
                )}
              </span>
              <ProviderChip provider={i.provider} model={i.observed_model} />
              <span className="text-muted-foreground" title={i.citation_evidence.length ? i.citation_evidence.map((c) => domainOf(c.uri)).join(", ") : "No source citation returned."}>
                {i.citation_evidence.length ? (
                  <span className="inline-flex items-center gap-1 font-medium text-foreground">
                    <LinkIcon className="size-3" />
                    {i.citation_evidence.length}
                  </span>
                ) : (
                  "None"
                )}
              </span>
              <span className="text-right whitespace-nowrap text-muted-foreground tabular-nums" title={formatDateTime(i.collected_at)}>
                {relativeTime(i.collected_at)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {pages > 1 ? (
        <div className="flex items-center justify-between border-t px-4 py-2 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {(current - 1) * PAGE_SIZE + 1}–{Math.min(current * PAGE_SIZE, rows.length)} of {rows.length}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" disabled={current <= 1} onClick={() => onPage(current - 1)} aria-label="Previous page">
              <ChevronLeftIcon />
            </Button>
            <span className="px-1 tabular-nums">
              Page {current} of {pages}
            </span>
            <Button variant="ghost" size="icon-sm" disabled={current >= pages} onClick={() => onPage(current + 1)} aria-label="Next page">
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      ) : null}
    </>
  )
}

function Count({ n }: { n: number | null }) {
  if (n === null) return null
  return <span className="rounded-full bg-muted px-1.5 text-[11px] leading-4 font-medium text-muted-foreground tabular-nums in-data-[state=active]:bg-secondary">{n}</span>
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-")

function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }))
  const link = document.createElement("a")
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

export type { IssueFilter }

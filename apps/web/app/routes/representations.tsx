import { useMemo, useState } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import { toast } from "sonner"
import {
  ArrowRightIcon,
  BookCheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EmptyState, PageHeader, Panel, PanelHeader, StatStrip, domainOf, pathOf, type Stat } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { ControlBadge, RepresentationStateBadge } from "@/components/status"
import { Facts, Representations, Sources, type RepresentationRow } from "@/lib/api"
import { errorMessage, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { representationFilterLabels, representationFilters, type RepresentationFilter } from "@/lib/nav"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

const filterTone: Record<RepresentationFilter, Stat["tone"] | undefined> = { ALL: undefined, DRIFT: "wrong", UNKNOWN: "unknown", IN_SYNC: "supported" }
const filterHint: Record<RepresentationFilter, string> = {
  ALL: "Fact and source pairs",
  DRIFT: "Source differs from approved",
  UNKNOWN: "Could not be compared",
  IN_SYNC: "Source matches approved",
}

export function RepresentationsPage() {
  const { id = "" } = useParams()
  const { data, loading, error, reload } = useApi(`representations:${id}`, () => Representations.list(id))
  const facts = useApi(`facts:${id}`, () => Facts.list(id))
  const [params, setParams] = useSearchParams()
  const filter = (representationFilters as readonly string[]).includes(params.get("state") ?? "") ? (params.get("state") as RepresentationFilter) : "ALL"
  const [q, setQ] = useState("")
  const [view, setView] = useState<"matrix" | "facts" | "pages">("matrix")
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set())

  const rows = useMemo(() => data?.representations ?? [], [data])
  const counts = useMemo(() => {
    const c: Record<RepresentationFilter, number> = { ALL: rows.length, IN_SYNC: 0, DRIFT: 0, UNKNOWN: 0 }
    for (const r of rows) {
      const s = r.finding.state as RepresentationFilter
      if (s === "IN_SYNC" || s === "DRIFT" || s === "UNKNOWN") c[s] += 1
    }
    return c
  }, [rows])
  const visible = rows.filter((r) => {
    if (filter !== "ALL" && r.finding.state !== filter) return false
    if (!q.trim()) return true
    const hay = `${r.fact.predicate} ${r.fact.valueText} ${r.source.url} ${r.effective_observation?.extracted_value ?? ""}`.toLowerCase()
    return hay.includes(q.trim().toLowerCase())
  })
  const untracked = useMemo(() => {
    const watched = new Set(rows.map((r) => r.fact.id))
    return (facts.data?.facts ?? []).filter((f) => f.status === "ACTIVE" && !watched.has(f.id))
  }, [rows, facts.data])

  const setFilter = (f: RepresentationFilter) => {
    const next = new URLSearchParams(params)
    if (f === "ALL") next.delete("state")
    else next.set("state", f)
    setParams(next, { replace: true })
  }

  const check = async (bindingIds: string[]) => {
    setChecking((s) => new Set([...s, ...bindingIds]))
    let drift = 0
    let failed = 0
    for (const b of bindingIds) {
      try {
        const r = await Sources.check(id, b)
        if (r.finding.state === "DRIFT") drift += 1
        if (r.observation.collection_state === "FAILED") failed += 1
      } catch {
        failed += 1
      } finally {
        setChecking((s) => {
          const next = new Set(s)
          next.delete(b)
          return next
        })
      }
    }
    await reload()
    const n = bindingIds.length
    if (failed) toast.error(`${failed} of ${n} source check${n === 1 ? "" : "s"} failed`, { description: "The last good observation stays in place." })
    else toast.success(`Checked ${n} source${n === 1 ? "" : "s"}`, { description: drift ? `${drift} still differ from the approved value.` : "Every checked source matches or could not be compared." })
  }

  const stats: Stat[] = representationFilters.map((f) => ({
    key: f,
    label: representationFilterLabels[f],
    value: loading ? <Skeleton className="h-5 w-8" /> : counts[f],
    hint: filterHint[f],
    ...(filterTone[f] ? { tone: filterTone[f] } : {}),
    active: filter === f,
    onSelect: () => setFilter(f),
  }))

  const byPage = useMemo(() => {
    const m = new Map<string, RepresentationRow[]>()
    for (const r of visible) m.set(r.source.url, [...(m.get(r.source.url) ?? []), r])
    return [...m.entries()].sort((a, b) => b[1].filter((r) => r.finding.state === "DRIFT").length - a[1].filter((r) => r.finding.state === "DRIFT").length)
  }, [visible])

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Representations"
        description="Where your approved facts appear on websites and other known sources, and whether what is published still matches."
        actions={
          <>
            <Button variant="outline" size="sm" disabled={rows.length === 0 || checking.size > 0} onClick={() => void check(rows.map((r) => r.binding_id))}>
              {checking.size > 0 ? <Spinner /> : <RefreshCwIcon />}
              {checking.size > 0 ? `Checking ${checking.size}…` : "Check all"}
            </Button>
            <Button asChild size="sm">
              <Link to={`/businesses/${id}/representations/discovery`}>
                <ScanSearchIcon />
                Discover sources
              </Link>
            </Button>
          </>
        }
      />

      <StatStrip stats={stats} className="lg:grid-cols-4" />

      {loading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : error && !data ? (
        <EmptyState
          icon={<TriangleAlertIcon />}
          title="Representations could not load"
          description={errorMessage(error)}
          action={
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              Try again
            </Button>
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<GlobeIcon />}
          title="No tracked representations yet"
          description="Configure source bindings for your approved facts to watch where they appear. An empty list does not mean everything is in sync."
          action={
            <Button asChild size="sm">
              <Link to={`/businesses/${id}/representations/discovery`}>
                <ScanSearchIcon />
                Discover sources
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_18rem]">
          <Panel>
            <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2">
              <Tabs value={view} onValueChange={(v) => setView(v as "matrix" | "facts" | "pages")}>
                <TabsList>
                  <TabsTrigger value="matrix">Matrix</TabsTrigger>
                  <TabsTrigger value="facts">By fact</TabsTrigger>
                  <TabsTrigger value="pages">By page</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="relative min-w-[10rem] flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Search facts, values, URLs" aria-label="Search representations" className="h-8 pr-8 pl-8 text-xs" />
                {q ? (
                  <button type="button" aria-label="Clear search" onClick={() => setQ("")} className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <XIcon className="size-3.5" />
                  </button>
                ) : null}
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={<GlobeIcon />}
                  title={q ? "Nothing matches this search" : `No ${representationFilterLabels[filter].toLowerCase()} representations`}
                  description="Switch to another filter to see the rest."
                  className="py-10"
                />
              </div>
            ) : view === "matrix" ? (
              <CoverageMatrix businessId={id} rows={visible} />
            ) : view === "facts" ? (
              <>
                <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem_5.5rem] gap-x-4 border-y bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground md:grid">
                  <span>Approved fact</span>
                  <span>Published value</span>
                  <span>Source</span>
                  <span>State</span>
                  <span className="text-right">Checked</span>
                </div>
                <ul className="divide-y">
                  {visible.map((r) => (
                    <RepresentationListRow key={r.binding_id} businessId={id} row={r} checking={checking.has(r.binding_id)} onCheck={() => void check([r.binding_id])} />
                  ))}
                </ul>
              </>
            ) : (
              <div className="space-y-3 p-3 pt-1">
                {byPage.map(([url, list]) => (
                  <div key={url} className="overflow-hidden rounded-lg border">
                    <div className="flex flex-wrap items-center gap-2 bg-muted/40 px-3 py-2">
                      <GlobeIcon className="size-3.5 text-muted-foreground" />
                      <a href={url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-xs font-medium hover:underline">
                        {domainOf(url)}
                        <span className="text-muted-foreground">{pathOf(url)}</span>
                      </a>
                      <ControlBadge control={list[0]!.source.control} />
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {list.length} fact{list.length === 1 ? "" : "s"} watched
                      </span>
                    </div>
                    <ul className="divide-y">
                      {list.map((r) => (
                        <li key={r.binding_id}>
                          <Link to={`/businesses/${id}/representations/${r.binding_id}`} className="flex items-center gap-3 px-3 py-2 text-xs transition-colors hover:bg-muted/40">
                            <span className="min-w-0 flex-1 truncate font-medium">{sentenceCase(r.fact.predicate)}</span>
                            <ValuePair approved={r.fact.valueText} observed={r.effective_observation?.extracted_value ?? null} drift={r.finding.state === "DRIFT"} />
                            <RepresentationStateBadge state={r.finding.state} />
                            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <div className="space-y-4">
            <Panel>
              <PanelHeader title="Coverage" description="Active facts with no source watching them" />
              <div className="p-2">
                {facts.loading ? (
                  <Skeleton className="m-2 h-16" />
                ) : untracked.length === 0 ? (
                  <p className="px-2 py-4 text-xs text-muted-foreground">Every active fact has at least one tracked source.</p>
                ) : (
                  <>
                    {untracked.map((f) => (
                      <div key={f.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
                        <BookCheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{sentenceCase(f.predicate)}</span> <span className="text-muted-foreground">{f.valueText}</span>
                        </span>
                      </div>
                    ))}
                    <Button asChild variant="ghost" size="sm" className="mt-1 h-7 w-full justify-between text-xs">
                      <Link to={`/businesses/${id}/representations/discovery`}>
                        Find pages that publish them
                        <ArrowRightIcon />
                      </Link>
                    </Button>
                  </>
                )}
              </div>
            </Panel>
            <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
              A check fetches the configured URL with the safe collector and compares the extracted value with the approved one. A failed check never erases the last good observation.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

/** Facts down, watched pages across: each cell is what that page publishes for that fact. */
function CoverageMatrix({ businessId, rows }: { businessId: string; rows: RepresentationRow[] }) {
  const facts = [...new Map(rows.map((r) => [r.fact.id, r.fact])).values()]
  const sources = [...new Map(rows.map((r) => [r.source.url, r.source])).values()]
  const cell = new Map(rows.map((r) => [`${r.fact.id}|${r.source.url}`, r]))
  return (
    <div className="overflow-x-auto px-3 pb-3">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-card px-2 pb-2 text-left text-[11px] font-normal text-muted-foreground">Approved fact</th>
            {sources.map((src) => (
              <th key={src.url} className="min-w-[10rem] px-2 pb-2 text-left align-bottom font-normal">
                <a href={src.url} target="_blank" rel="noreferrer" className="block truncate text-[11px] font-medium text-foreground hover:underline">
                  {domainOf(src.url)}
                </a>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {pathOf(src.url)} · {src.control === "OWNED" ? "owned" : src.control === "THIRD_PARTY" ? "third party" : "unknown control"}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {facts.map((f) => (
            <tr key={f.id}>
              <td className="sticky left-0 z-10 border-t bg-card px-2 py-2 align-middle">
                <span className="block font-medium">{sentenceCase(f.predicate)}</span>
                <span className="block text-[11px] text-muted-foreground">
                  Approved {f.valueText} · v{f.version}
                </span>
              </td>
              {sources.map((src) => {
                const r = cell.get(`${f.id}|${src.url}`)
                if (!r)
                  return (
                    <td key={src.url} className="border-t px-2 py-2 text-[11px] text-muted-foreground/60">
                      Not watched
                    </td>
                  )
                const state = r.finding.state
                return (
                  <td key={src.url} className="border-t px-1 py-1">
                    <Link
                      to={`/businesses/${businessId}/representations/${r.binding_id}`}
                      className={cn(
                        "flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors",
                        state === "DRIFT" ? "bg-wrong-soft hover:bg-wrong-soft/70" : state === "IN_SYNC" ? "bg-supported-soft/70 hover:bg-supported-soft" : "bg-unknown-soft/70 hover:bg-unknown-soft",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn("size-1.5 shrink-0 rounded-full", state === "DRIFT" ? "bg-wrong" : state === "IN_SYNC" ? "bg-supported" : "bg-unknown")}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{r.effective_observation?.extracted_value ?? "Not observed yet"}</span>
                      {r.latest_attempt?.collection_state === "FAILED" ? <TriangleAlertIcon className="size-3 shrink-0 text-partial" aria-label="Latest check failed" /> : null}
                    </Link>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 flex flex-wrap gap-4 px-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-supported" />In sync</span>
        <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-wrong" />Drift, page differs from approved</span>
        <span className="flex items-center gap-1.5"><span className="size-1.5 rounded-full bg-unknown" />Unknown, could not compare</span>
        <span className="flex items-center gap-1.5"><TriangleAlertIcon className="size-3 text-partial" />Latest check failed</span>
      </div>
    </div>
  )
}

function ValuePair({ approved, observed, drift }: { approved: string; observed: string | null; drift: boolean }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 tabular-nums">
      {observed === null ? (
        <span className="text-muted-foreground">Not observed yet</span>
      ) : (
        <span className={cn("truncate font-medium", drift && "text-wrong")}>{observed}</span>
      )}
      {drift ? <span className="truncate text-[11px] text-muted-foreground">approved {approved}</span> : null}
    </span>
  )
}

function RepresentationListRow({ businessId, row: r, checking, onCheck }: { businessId: string; row: RepresentationRow; checking: boolean; onCheck: () => void }) {
  const failedLatest = r.latest_attempt?.collection_state === "FAILED"
  const effectiveFailed = r.effective_observation === null
  const href = `/businesses/${businessId}/representations/${r.binding_id}`
  return (
    <li className="group relative grid items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-xs transition-colors hover:bg-muted/40 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_6.5rem_5.5rem]">
      <Link to={href} className="min-w-0 after:absolute after:inset-0" aria-label={`Open representation for ${sentenceCase(r.fact.predicate)}`}>
        <span className="block truncate font-medium">{sentenceCase(r.fact.predicate)}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          Approved {r.fact.valueText} · v{r.fact.version}
        </span>
      </Link>
      <span className="min-w-0">
        {r.effective_observation ? (
          <span className={cn("block truncate font-medium", r.finding.state === "DRIFT" && "text-wrong")}>{r.effective_observation.extracted_value ?? "—"}</span>
        ) : (
          <span className="text-muted-foreground">Not observed yet</span>
        )}
        {failedLatest && !effectiveFailed ? (
          <span className="flex items-center gap-1 text-[11px] text-partial">
            <TriangleAlertIcon className="size-3" />
            Latest check failed
          </span>
        ) : (
          <span className="block truncate text-[11px] text-muted-foreground">{r.finding.reason}</span>
        )}
      </span>
      <span className="relative z-10 flex min-w-0 items-center gap-1.5">
        <a href={r.source.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 truncate hover:underline">
          <span className="truncate">{domainOf(r.source.url)}</span>
          <span className="truncate text-muted-foreground">{pathOf(r.source.url)}</span>
          <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
        </a>
      </span>
      <span>
        <RepresentationStateBadge state={r.finding.state} />
      </span>
      <span className="relative z-10 flex items-center justify-end gap-1">
        <span className="whitespace-nowrap text-muted-foreground group-hover:hidden" title={r.latest_attempt ? formatDateTime(r.latest_attempt.completed_at) : undefined}>
          {r.latest_attempt ? relativeTime(r.latest_attempt.completed_at) : "Never"}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" className={cn("h-7 px-2 text-xs", !checking && "hidden group-hover:inline-flex")} disabled={checking} onClick={onCheck}>
              {checking ? <Spinner /> : <RefreshCwIcon className="size-3.5" />}
              Check
            </Button>
          </TooltipTrigger>
          <TooltipContent>Fetch this source again now</TooltipContent>
        </Tooltip>
      </span>
    </li>
  )
}

export function domainLabel(url: string): string {
  return domainOf(url)
}

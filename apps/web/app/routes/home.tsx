import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { ArrowDownRightIcon, ArrowUpRightIcon, Building2Icon, ChevronRightIcon, PlusIcon, SearchIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Sparkline } from "@/components/charts"
import { CreateBusinessDialog } from "@/components/create-business-dialog"
import { EmptyState, PageHeader, Panel, StatStrip } from "@/components/page"
import { AnalyticsApi, Issues, type Analytics, type Business, type Overview, type VerdictCounts } from "@/lib/api"
import { initial, relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

const reviewedOf = (c: VerdictCounts) => c.supported + c.wrong + c.partial + c.unknown
const accuracyOf = (c: VerdictCounts) => (reviewedOf(c) ? c.supported / reviewedOf(c) : null)

type Row = { business: Business; overview: Overview | null; analytics: Analytics | null; loading: boolean }
type Sort = "attention" | "accuracy" | "name" | "recent"

/** One overview and one 30-day analytics read per business, loaded in parallel. */
function usePortfolio(businesses: Business[]): Row[] {
  const [data, setData] = useState<Record<string, { overview: Overview | null; analytics: Analytics | null; done: boolean }>>({})
  const key = businesses.map((b) => b.id).join(",")
  useEffect(() => {
    let alive = true
    for (const b of businesses) {
      void Promise.allSettled([Issues.overview(b.id), AnalyticsApi.get(b.id, 30)]).then(([o, a]) => {
        if (!alive) return
        setData((d) => ({
          ...d,
          [b.id]: { overview: o.status === "fulfilled" ? o.value.overview : null, analytics: a.status === "fulfilled" ? a.value.analytics : null, done: true },
        }))
      })
    }
    return () => {
      alive = false
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return businesses.map((b) => ({ business: b, overview: data[b.id]?.overview ?? null, analytics: data[b.id]?.analytics ?? null, loading: !data[b.id]?.done }))
}

export function Home() {
  const { businesses, businessesLoading, setActiveBusinessId } = useWorkspace()
  const [params, setParams] = useSearchParams()
  const [createOpen, setCreateOpen] = useState(params.get("new") === "1")
  const [q, setQ] = useState("")
  const [sort, setSort] = useState<Sort>("attention")

  useEffect(() => setActiveBusinessId(null), [setActiveBusinessId])
  useEffect(() => {
    if (params.get("new") === "1") {
      setCreateOpen(true)
      setParams({}, { replace: true })
    }
  }, [params, setParams])

  const rows = usePortfolio(businesses)
  const visible = useMemo(() => {
    const list = rows.filter((r) => r.business.name.toLowerCase().includes(q.trim().toLowerCase()))
    const attention = (r: Row) => (r.overview ? Number(r.overview.needs_attention) + Number(r.overview.unreviewed) : -1)
    return [...list].sort((a, b) => {
      if (sort === "name") return a.business.name.localeCompare(b.business.name)
      if (sort === "accuracy") return (accuracyOf(a.analytics?.current ?? emptyCounts) ?? 2) - (accuracyOf(b.analytics?.current ?? emptyCounts) ?? 2)
      if (sort === "recent") return (b.overview?.last_checked ?? "").localeCompare(a.overview?.last_checked ?? "")
      return attention(b) - attention(a)
    })
  }, [rows, q, sort])

  const totals = useMemo(() => {
    const done = rows.filter((r) => !r.loading)
    return {
      attention: done.reduce((n, r) => n + Number(r.overview?.needs_attention ?? 0), 0),
      unreviewed: done.reduce((n, r) => n + Number(r.overview?.unreviewed ?? 0), 0),
      never: done.filter((r) => !r.overview?.last_checked).length,
      loading: done.length < rows.length,
    }
  }, [rows])
  const stat = (v: number) => (totals.loading ? <Skeleton className="h-4 w-8" /> : v.toLocaleString())

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Businesses"
        description="Every business you track, with what needs attention first. Open one to review its issues, run checks, and manage approved facts."
        actions={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            New business
          </Button>
        }
      />

      {businessesLoading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : businesses.length === 0 ? (
        <EmptyState
          icon={<Building2Icon />}
          title="Add your first business"
          description="OpenRecord compares what AI assistants say about a business with the facts you approve for it."
          action={
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              New business
            </Button>
          }
        />
      ) : (
        <>
          <StatStrip
            stats={[
              { key: "n", label: "Businesses", value: businesses.length, hint: "In this account" },
              { key: "attention", label: "Need attention", value: stat(totals.attention), hint: "Wrong or partial claims", tone: "wrong" },
              { key: "review", label: "To review", value: stat(totals.unreviewed), hint: "Answers waiting for a verdict", tone: "review" },
              { key: "never", label: "Never checked", value: stat(totals.never), hint: "Run a first check", tone: "partial" },
            ]}
          />

          <Panel>
            <div className="flex flex-wrap items-center gap-2 px-3 pt-3 pb-2">
              <div className="relative min-w-[10rem] flex-1">
                <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Search businesses" aria-label="Search businesses" className="h-8 pl-8" />
              </div>
              <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                <SelectTrigger className="h-8 w-[10rem]" aria-label="Sort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="attention">Most attention first</SelectItem>
                  <SelectItem value="accuracy">Lowest accuracy first</SelectItem>
                  <SelectItem value="recent">Recently checked</SelectItem>
                  <SelectItem value="name">Name</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="hidden grid-cols-[minmax(0,1.4fr)_7rem_minmax(0,1fr)_6rem_6rem_7rem_1rem] gap-x-4 border-y bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground md:grid">
              <span>Business</span>
              <span>Accuracy, 30 days</span>
              <span>AI mentions per day</span>
              <span className="text-right">Need attention</span>
              <span className="text-right">To review</span>
              <span className="text-right">Last checked</span>
              <span />
            </div>
            {visible.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-muted-foreground">No business matches &ldquo;{q}&rdquo;.</p>
            ) : (
              <ul className="divide-y">
                {visible.map((r) => (
                  <PortfolioRow key={r.business.id} row={r} />
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}

      <CreateBusinessDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}

const emptyCounts: VerdictCounts = { supported: 0, wrong: 0, partial: 0, unknown: 0, unreviewed: 0 }

function PortfolioRow({ row }: { row: Row }) {
  const { business: b, overview: o, analytics: a, loading } = row
  const acc = a ? accuracyOf(a.current) : null
  const prevAcc = a ? accuracyOf(a.previous) : null
  const pts = acc !== null && prevAcc !== null ? Math.round((acc - prevAcc) * 100) : null
  const mentions = useMemo(() => {
    if (!a) return []
    const byDate = new Map<string, number>()
    for (const d of a.providerDaily) byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.mentions)
    return [...byDate.entries()].sort((x, y) => x[0].localeCompare(y[0])).slice(1).map(([, v]) => v)
  }, [a])
  const attention = o ? Number(o.needs_attention) : 0
  const unreviewed = o ? Number(o.unreviewed) : 0
  return (
    <li>
      <Link
        to={`/businesses/${b.id}/overview`}
        className="grid items-center gap-x-4 gap-y-2 px-4 py-2.5 text-xs transition-colors hover:bg-muted/40 md:grid-cols-[minmax(0,1.4fr)_7rem_minmax(0,1fr)_6rem_6rem_7rem_1rem]"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">{initial(b.name)}</span>
          <span className="min-w-0">
            <span className="block truncate font-medium">{b.name}</span>
            <span className="block text-[11px] text-muted-foreground">{loading ? "Loading…" : o ? `${Number(o.completed).toLocaleString()} checks done` : "No data"}</span>
          </span>
        </span>
        <span className="flex items-baseline gap-1.5">
          {loading ? (
            <Skeleton className="h-4 w-12" />
          ) : (
            <>
              <span className="font-semibold tabular-nums">{acc === null ? "—" : `${Math.round(acc * 100)}%`}</span>
              {pts !== null && pts !== 0 ? (
                <span className={cn("inline-flex items-center text-[11px] tabular-nums", pts > 0 ? "text-supported" : "text-wrong")}>
                  {pts > 0 ? <ArrowUpRightIcon className="size-3" /> : <ArrowDownRightIcon className="size-3" />}
                  {Math.abs(pts)} pts
                </span>
              ) : null}
            </>
          )}
        </span>
        <span>{loading ? <Skeleton className="h-4 w-full" /> : mentions.length > 1 ? <Sparkline values={mentions} cssVar="--chart-primary" className="h-6" /> : <span className="text-[11px] text-muted-foreground">No mentions yet</span>}</span>
        <span className={cn("text-right font-medium tabular-nums", attention > 0 && "text-wrong")}>{loading ? "" : attention.toLocaleString()}</span>
        <span className={cn("text-right font-medium tabular-nums", unreviewed > 0 && "text-review")}>{loading ? "" : unreviewed.toLocaleString()}</span>
        <span className="text-right text-muted-foreground">{loading ? "" : o?.last_checked ? relativeTime(o.last_checked) : "Never"}</span>
        <ChevronRightIcon className="hidden size-3.5 text-muted-foreground md:block" />
      </Link>
    </li>
  )
}

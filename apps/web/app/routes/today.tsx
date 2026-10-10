import { useMemo, useState, type ReactNode } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import { ArrowRightIcon, BarChart3Icon, CalendarIcon, DownloadIcon, RadarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AreaTrendChart,
  SeriesLogo,
  VerdictBar,
  modelSeries,
  pivotMentions,
  totalClaims,
  type ModelSeries,
} from "@/components/charts"
import { EmptyState, PageHeader, Panel, PanelHeader, ShareRow, StatStrip, type Stat } from "@/components/page"
import { ControlBadge, IssueStateBadge, RepresentationStateBadge } from "@/components/status"
import { AnalyticsApi, Facts, Issues, Representations, type Analytics, type VerdictCounts } from "@/lib/api"
import { groupClaims } from "@/lib/issues"
import { errorMessage, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

const periods = [7, 30, 90] as const
type Period = (typeof periods)[number]

function shortDate(iso: string): string {
  // Day buckets are UTC dates (YYYY-MM-DD); render them without shifting.
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
}

const reviewed = (c: VerdictCounts) => c.supported + c.wrong + c.partial + c.unknown
const accuracy = (c: VerdictCounts) => (reviewed(c) ? c.supported / reviewed(c) : null)
const pct = (n: number | null, digits = 0) => (n === null ? "—" : `${(n * 100).toFixed(digits)}%`)
const sumCounts = (rows: VerdictCounts[]): VerdictCounts =>
  rows.reduce(
    (t, r) => ({ supported: t.supported + r.supported, wrong: t.wrong + r.wrong, partial: t.partial + r.partial, unknown: t.unknown + r.unknown, unreviewed: t.unreviewed + r.unreviewed }),
    { supported: 0, wrong: 0, partial: 0, unknown: 0, unreviewed: 0 },
  )

/** Everything the page derives from one analytics payload, grouped per model series. */
function useModelStats(a: Analytics | null) {
  return useMemo(() => {
    if (!a) return null
    const series = modelSeries([...a.providers.map((p) => p.provider), ...a.providerDaily.map((d) => d.provider)])
    const rows = pivotMentions(a.providerDaily, series)
    const models = series.map((s) => {
      const members = a.providers.filter((p) => s.members.includes(p.provider))
      const counts = sumCounts(members)
      return {
        series: s,
        answers: members.reduce((n, p) => n + p.answers, 0),
        prev: members.reduce((n, p) => n + (p.prev_answers ?? 0), 0),
        counts,
        claims: totalClaims(counts),
        accuracy: accuracy(counts),
      }
    })
    const total = models.reduce((n, m) => n + m.answers, 0)
    const prevTotal = models.reduce((n, m) => n + m.prev, 0)
    const dailyTotals = rows.map((r) => ({ date: String(r.date), value: series.reduce((n, s) => n + Number(r[s.key] ?? 0), 0) }))
    return {
      series,
      rows,
      models,
      ranked: [...models].sort((x, y) => y.answers - x.answers),
      total,
      prevTotal,
      dailyTotals,
    }
  }, [a])
}

type ModelStats = NonNullable<ReturnType<typeof useModelStats>>

type MetricKey = "mentions" | "accuracy" | "wrong" | "partial" | "unreviewed" | "checks"

const metricMeta: Record<MetricKey, { label: string; tone?: Stat["tone"]; goodWhenUp: boolean; percent?: boolean }> = {
  mentions: { label: "AI mentions", goodWhenUp: true },
  accuracy: { label: "Accuracy", goodWhenUp: true, percent: true },
  wrong: { label: "Wrong", tone: "wrong", goodWhenUp: false },
  partial: { label: "Partial", tone: "partial", goodWhenUp: false },
  unreviewed: { label: "To review", tone: "review", goodWhenUp: false },
  checks: { label: "Checks run", goodWhenUp: true },
}

/** Trailing moving average; the comparison line under each trend. */
function trailing(values: Array<number | null>, window: number): Array<number | null> {
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1).filter((v): v is number => v !== null)
    return slice.length ? Math.round((slice.reduce((n, v) => n + v, 0) / slice.length) * 1000) / 1000 : null
  })
}

export function Today() {
  const { id = "" } = useParams()
  const { activeBusiness } = useWorkspace()
  const [params, setParams] = useSearchParams()
  const days: Period = periods.includes(Number(params.get("days")) as Period) ? (Number(params.get("days")) as Period) : 30
  const metric: MetricKey = (Object.keys(metricMeta) as MetricKey[]).includes(params.get("metric") as MetricKey) ? (params.get("metric") as MetricKey) : "mentions"
  const { data, loading, error } = useApi(`analytics:${id}:${days}`, () => AnalyticsApi.get(id, days))
  const a = data?.analytics ?? null
  const stats = useModelStats(a)

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params)
    next.set(k, v)
    setParams(next, { replace: true })
  }

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title={activeBusiness?.name ?? "Overview"}
        description="How often AI models mention you, and whether what they say matches your approved facts."
        actions={
          <>
            <Select value={String(days)} onValueChange={(v) => setParam("days", v)}>
              <SelectTrigger className="h-8 w-[9.5rem] text-xs" aria-label="Time range">
                <CalendarIcon className="size-3.5 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {periods.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    Last {p} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" className="h-8 text-xs" disabled={!a} onClick={() => a && downloadCsv(a, activeBusiness?.name ?? "business")}>
              <DownloadIcon />
              Export
            </Button>
            <Button asChild size="sm" className="h-8 text-xs">
              <Link to={`/businesses/${id}/checks`}>
                <RadarIcon />
                Run a check
              </Link>
            </Button>
          </>
        }
      />

      {error && !a ? (
        <EmptyState icon={<BarChart3Icon />} title="Analytics could not load" description={errorMessage(error)} />
      ) : (
        <>
          <Kpis a={a} stats={stats} loading={loading} metric={metric} onMetric={(m) => setParam("metric", m)} />
          <HeroChart a={a} stats={stats} loading={loading} metric={metric} days={days} brand={activeBusiness?.name ?? "you"} />
          <div className="grid gap-4 lg:grid-cols-2">
            <ShareOfVoiceCard stats={stats} loading={loading} days={days} />
            <AccuracyByModelCard a={a} stats={stats} loading={loading} />
            <NeedsALookCard businessId={id} />
            <QuestionsCard businessId={id} a={a} loading={loading} days={days} />
          </div>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ KPIs */

function Kpis({ a, stats, loading, metric, onMetric }: { a: Analytics | null; stats: ModelStats | null; loading: boolean; metric: MetricKey; onMetric: (m: MetricKey) => void }) {
  const values: Record<MetricKey, { value: ReactNode; delta: ReactNode }> | null = useMemo(() => {
    if (!a || !stats) return null
    const acc = accuracy(a.current)
    const prevAcc = accuracy(a.previous)
    return {
      mentions: { value: stats.total.toLocaleString(), delta: <Delta now={stats.total} prev={stats.prevTotal} goodWhenUp /> },
      accuracy: {
        value: pct(acc),
        delta: acc !== null && prevAcc !== null ? <PointsDelta pts={Math.round((acc - prevAcc) * 100)} /> : null,
      },
      wrong: { value: a.current.wrong.toLocaleString(), delta: <Delta now={a.current.wrong} prev={a.previous.wrong} goodWhenUp={false} /> },
      partial: { value: a.current.partial.toLocaleString(), delta: <Delta now={a.current.partial} prev={a.previous.partial} goodWhenUp={false} /> },
      unreviewed: { value: a.current.unreviewed.toLocaleString(), delta: <Delta now={a.current.unreviewed} prev={a.previous.unreviewed} goodWhenUp={false} /> },
      checks: { value: a.current.checks.toLocaleString(), delta: <Delta now={a.current.checks} prev={a.previous.checks} goodWhenUp /> },
    }
  }, [a, stats])

  const stats_: Stat[] = (Object.keys(metricMeta) as MetricKey[]).map((k) => ({
    key: k,
    label: metricMeta[k].label,
    value: loading || !values ? <Skeleton className="h-5 w-14" /> : values[k].value,
    delta: loading || !values ? null : values[k].delta,
    ...(metricMeta[k].tone ? { tone: metricMeta[k].tone } : {}),
    active: metric === k,
    onSelect: () => onMetric(k),
  }))
  return <StatStrip stats={stats_} />
}

function Delta({ now, prev, goodWhenUp }: { now: number; prev: number; goodWhenUp: boolean }) {
  if (!prev) return now ? <span className="text-muted-foreground">New</span> : null
  const change = (now - prev) / prev
  if (Math.abs(change) < 0.005) return <span className="text-muted-foreground">0%</span>
  const good = change > 0 === goodWhenUp
  return (
    <span className={good ? "text-supported" : "text-wrong"} title="Change vs previous period">
      {change > 0 ? "+" : ""}
      {(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%
    </span>
  )
}

function PointsDelta({ pts }: { pts: number }) {
  if (pts === 0) return <span className="text-muted-foreground">0 pts</span>
  return (
    <span className={pts > 0 ? "text-supported" : "text-wrong"} title="Change vs previous period, in percentage points">
      {pts > 0 ? "+" : ""}
      {pts} pts
    </span>
  )
}

/* ----------------------------------------------------------- Hero chart */

const verdictShareMeta = {
  accuracy: { key: "supported", label: "Supported share", cssVar: "--chart-supported" },
  wrong: { key: "wrong", label: "Wrong share", cssVar: "--chart-wrong" },
  partial: { key: "partial", label: "Partially correct share", cssVar: "--chart-partial" },
  unreviewed: { key: "unreviewed", label: "Waiting-for-review share", cssVar: "--chart-unreviewed" },
} as const
type VerdictShareMetric = keyof typeof verdictShareMeta

function HeroChart({ a, stats, loading, metric, days, brand }: { a: Analytics | null; stats: ModelStats | null; loading: boolean; metric: MetricKey; days: number; brand: string }) {
  const [view, setView] = useState<"trend" | "split">("trend")
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set())
  const [focus, setFocus] = useState<string | null>(null)
  const meta = metricMeta[metric]
  const window = days > 7 ? 7 : 3

  // The first bucket covers only part of a day, so it stays out of every trend.
  const series = useMemo(() => {
    if (!a || !stats) return []
    const raw: Array<{ date: string; value: number | null }> =
      metric === "mentions"
        ? stats.dailyTotals
        : a.daily.map((d) => ({
            date: d.date,
            value: metric === "accuracy" ? (accuracy(d) === null ? null : Math.round(accuracy(d)! * 1000) / 10) : metric === "checks" ? d.checks : d[metric],
          }))
    const trimmed = raw.slice(1)
    const avg = trailing(
      trimmed.map((r) => r.value),
      window,
    )
    return trimmed.map((r, i) => ({ date: r.date, value: r.value ?? "", avg: avg[i] ?? "" }))
  }, [a, stats, metric, window])

  const splitLabel = metric === "mentions" ? "By model" : metric === "checks" ? null : "Verdict share"
  // The split view answers the complementary question: not how many, but
  // what share of the day's verdicts the selected one represents.
  const shareSeries = useMemo(() => {
    if (!a || metric === "mentions" || metric === "checks") return []
    const key = verdictShareMeta[metric].key
    const raw = a.daily.slice(1).map((d) => {
      const t = totalClaims(d)
      return { date: d.date, value: t ? Math.round(((d[key] ?? 0) / t) * 1000) / 10 : null }
    })
    const avg = trailing(
      raw.map((r) => r.value),
      window,
    )
    return raw.map((r, i) => ({ date: r.date, value: r.value ?? "", avg: avg[i] ?? "" }))
  }, [a, metric, window])
  const subtitle =
    metric === "mentions"
      ? `How often each AI model mentions ${brand}, per day`
      : metric === "accuracy"
        ? "Supported ÷ reviewed claims, per day"
        : metric === "checks"
          ? "Questions sent to AI models, per day"
          : metric === "unreviewed" ? "Claims waiting for a reviewer's verdict, per day" : `${meta.label === "Partial" ? "Partially correct" : meta.label} claims found in AI answers, per day`

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xs leading-tight font-medium">{meta.label} over time</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {subtitle} · last {days} days
          </p>
        </div>
        {splitLabel ? (
          <Tabs value={view} onValueChange={(v) => setView(v as "trend" | "split")}>
            <TabsList>
              <TabsTrigger value="trend">Trend</TabsTrigger>
              <TabsTrigger value="split">{splitLabel}</TabsTrigger>
            </TabsList>
          </Tabs>
        ) : null}
      </div>

      {loading || !a || !stats ? (
        <Skeleton className="h-[280px] rounded-xl" />
      ) : series.every((r) => r.value === "" || r.value === 0) && totalClaims(a.current) === 0 && stats.total === 0 ? (
        <ChartEmpty days={days} what={metric === "mentions" ? "answers" : "claims"} />
      ) : view === "split" && metric === "mentions" ? (
        <div className="space-y-3">
          <ModelSmallMultiples rows={stats.rows.slice(1)} series={stats.series} hidden={hidden} focus={focus} />
          <ul className="flex flex-wrap gap-1" onMouseLeave={() => setFocus(null)}>
            {stats.ranked.map((m) => {
              const off = hidden.has(m.series.key)
              return (
                <li key={m.series.key}>
                  <button
                    type="button"
                    aria-pressed={!off}
                    onMouseEnter={() => !off && setFocus(m.series.key)}
                    onClick={() =>
                      setHidden((prev) => {
                        const next = new Set(prev)
                        if (next.has(m.series.key)) next.delete(m.series.key)
                        else next.add(m.series.key)
                        return next.size >= stats.series.length ? new Set() : next
                      })
                    }
                    className={cn("flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-foreground/[0.05]", off && "opacity-40")}
                  >
                    <span aria-hidden className="size-2 rounded-full" style={{ background: `var(${m.series.cssVar})` }} />
                    {m.series.label}
                    <span className="text-muted-foreground tabular-nums">{m.answers}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ) : view === "split" && metric !== "checks" ? (
        <div className="space-y-2">
          <AreaTrendChart
            data={shareSeries}
            dataKey="value"
            label={verdictShareMeta[metric as VerdictShareMetric].label}
            compareKey="avg"
            compareLabel={`${window}-day average`}
            height={280}
            formatDate={shortDate}
            formatValue={(v) => `${Math.round(v)}%`}
            domain={[0, 100]}
            cssVar={verdictShareMeta[metric as VerdictShareMetric].cssVar}
          />
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full" style={{ background: `var(${verdictShareMeta[metric as VerdictShareMetric].cssVar})` }} />
              {verdictShareMeta[metric as VerdictShareMetric].label}
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="w-3 border-t-[1.5px] border-dotted border-chart-compare" />
              {window}-day average
            </span>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <AreaTrendChart
            data={series}
            dataKey="value"
            label={meta.label}
            compareKey="avg"
            compareLabel={`${window}-day average`}
            height={280}
            formatDate={shortDate}
            formatValue={meta.percent ? (v) => `${Math.round(v)}%` : (v) => (Math.round(v * 10) / 10).toLocaleString()}
            {...(meta.percent ? { domain: [0, 100] as [number, number] } : {})}
          />
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-chart-primary" />
              {meta.label}
            </span>
            <span className="flex items-center gap-1.5">
              <span aria-hidden className="w-3 border-t-[1.5px] border-dotted border-chart-compare" />
              {window}-day average
            </span>
          </div>
        </div>
      )}
    </section>
  )
}

/* --------------------------------------------------------------- Cards */

/** One mini trend per model: the same line language as the Trend tab, so no model hides behind another. */
function ModelSmallMultiples({ rows, series, hidden, focus }: { rows: Array<Record<string, number | string>>; series: readonly ModelSeries[]; hidden: ReadonlySet<string>; focus: string | null }) {
  const visible = series.filter((s) => !hidden.has(s.key))
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {visible.map((s) => {
        const total = rows.reduce((n, r) => n + Number(r[s.key] ?? 0), 0)
        return (
          <div key={s.key} className={cn("rounded-xl bg-card p-3 shadow-(--card-shadow-raised) transition-opacity", focus !== null && focus !== s.key && "opacity-40")}>
            <div className="flex items-center gap-2 px-1 pb-1">
              <SeriesLogo series={s} className="size-4" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{s.label}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{total.toLocaleString()} mentions</span>
            </div>
            <AreaTrendChart
              data={rows as Array<Record<string, number | string>>}
              dataKey={s.key}
              label={s.label}
              height={110}
              formatDate={shortDate}
              formatValue={(v) => Math.round(v).toLocaleString()}
              cssVar={s.cssVar}
            />
          </div>
        )
      })}
    </div>
  )
}

function ShareOfVoiceCard({ stats, loading, days }: { stats: ModelStats | null; loading: boolean; days: number }) {
  const max = stats ? Math.max(0.01, ...stats.ranked.map((m) => (stats.total ? m.answers / stats.total : 0))) : 1
  return (
    <Panel className="shadow-(--card-shadow-raised)">
      <PanelHeader title="Share of voice" description={stats ? `${stats.total.toLocaleString()} mentions across ${stats.series.length} models` : "Mentions per model"} />
      <div className="p-2 pt-2">
        {loading || !stats ? (
          <ListSkeleton />
        ) : stats.total === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-muted-foreground">No answers in the last {days} days.</p>
        ) : (
          <>
            <div className="flex justify-between px-2 pb-1 text-[11px] text-muted-foreground">
              <span>Model</span>
              <span>Share · change</span>
            </div>
            <div className="space-y-1">
            {stats.ranked.map((m) => {
              const share = stats.total ? m.answers / stats.total : 0
              const prevShare = stats.prevTotal ? m.prev / stats.prevTotal : null
              const pts = prevShare === null ? null : Math.round((share - prevShare) * 1000) / 10
              return (
                <ShareRow
                  key={m.series.key}
                  share={share / max}
                  value={
                    <span className="flex items-center gap-3">
                      <span>{pct(share, 1)}</span>
                      <span className={cn("w-10 text-right text-[11px]", pts === null ? "text-muted-foreground" : pts > 0 ? "text-supported" : pts < 0 ? "text-wrong" : "text-muted-foreground")}>
                        {pts === null ? "New" : `${pts > 0 ? "+" : ""}${pts.toFixed(1)}`}
                      </span>
                    </span>
                  }
                >
                  <SeriesLogo series={m.series} className="size-4" />
                  <span className="truncate font-medium">{m.series.label}</span>
                  <span className="text-muted-foreground tabular-nums">{m.answers.toLocaleString()}</span>
                </ShareRow>
              )
            })}
            </div>
            <p className="px-2 pt-2 text-[11px] text-muted-foreground">Change in share points vs the previous {days} days.</p>
          </>
        )}
      </div>
    </Panel>
  )
}

function AccuracyByModelCard({ a, stats, loading }: { a: Analytics | null; stats: ModelStats | null; loading: boolean }) {
  const byModel = useMemo(() => (stats ? [...stats.models].filter((m) => m.claims > 0).sort((x, y) => (y.accuracy ?? -1) - (x.accuracy ?? -1) || y.claims - x.claims) : []), [stats])
  return (
    <Panel className="shadow-(--card-shadow-raised)">
      <PanelHeader title="Accuracy by model" description={a ? `${pct(accuracy(a.current))} of ${reviewed(a.current).toLocaleString()} reviewed claims are supported` : "Supported ÷ reviewed claims"} />
      <div className="p-2 pt-2">
        {loading || !stats ? (
          <ListSkeleton />
        ) : byModel.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-muted-foreground">No reviewed claims yet.</p>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_3rem_3.5rem] gap-3 px-2 pb-1 text-[11px] text-muted-foreground">
              <span>Model</span>
              <span>Verdicts</span>
              <span className="text-right">Accurate</span>
              <span className="text-right">Wrong</span>
            </div>
            {byModel.map((m) => (
              <div key={m.series.key} className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_3rem_3.5rem] items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.03]">
                <span className="flex min-w-0 items-center gap-2 text-xs">
                  <SeriesLogo series={m.series} className="size-4" />
                  <span className="truncate font-medium">{m.series.label}</span>
                </span>
                <VerdictBar counts={m.counts} className="h-1.5" />
                <span className="text-right text-xs font-medium tabular-nums">{pct(m.accuracy)}</span>
                <span className="text-right text-xs text-muted-foreground tabular-nums">{m.counts.wrong}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </Panel>
  )
}

function NeedsALookCard({ businessId }: { businessId: string }) {
  const issues = useApi(`issues:${businessId}`, () => Issues.list(businessId))
  const representations = useApi(`representations:${businessId}`, () => Representations.list(businessId))
  const facts = useApi(`facts:${businessId}`, () => Facts.list(businessId))
  const [tab, setTab] = useState<"claims" | "sources">("claims")
  const loading = issues.loading || representations.loading || facts.loading
  const groups = useMemo(() => groupClaims(issues.data?.issues ?? [], "frequent").slice(0, 6), [issues.data])
  const reps = representations.data?.representations ?? []
  const drift = reps.filter((r) => r.finding.state !== "IN_SYNC")
  const max = Math.max(1, ...groups.map((g) => g.occurrences.length))
  const activeFacts = (facts.data?.facts ?? []).filter((f) => f.status === "ACTIVE").length

  return (
    <Panel className="shadow-(--card-shadow-raised)">
      <PanelHeader title="Needs a look" description={`${activeFacts} approved facts · ${reps.filter((r) => r.finding.state === "IN_SYNC").length} of ${reps.length} sources in sync`}>
        <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
          <Link to={`/businesses/${businessId}/${tab === "claims" ? "issues" : "representations"}`}>
            View all
            <ArrowRightIcon />
          </Link>
        </Button>
      </PanelHeader>
      <div className="px-4 pt-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "claims" | "sources")}>
          <TabsList>
            <TabsTrigger value="claims">Repeated claims</TabsTrigger>
            <TabsTrigger value="sources">
              Sources <span className="text-muted-foreground tabular-nums">{drift.length}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="p-2">
        {loading ? (
          <ListSkeleton />
        ) : tab === "claims" ? (
          groups.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">Nothing disagrees with your approved truth right now.</p>
          ) : (
            <div className="space-y-1">
            {groups.map((g) => {
              const target = g.occurrences.find((o) => o.state !== "NEEDS_REVIEW") ?? g.latest
              return (
                <Link
                  key={g.key}
                  to={target.state === "NEEDS_REVIEW" ? `/observations/${target.observation_id}?claim=${target.claim_id}` : `/businesses/${businessId}/issues/${target.claim_id}`}
                  className="block rounded-md transition-colors hover:bg-foreground/[0.03]"
                >
                  <ShareRow share={g.occurrences.length / max} value={`${g.occurrences.length}×`}>
                    <span className="min-w-0 flex-1 truncate">{g.text}</span>
                    <IssueStateBadge state={g.state} />
                  </ShareRow>
                </Link>
              )
            })}
            </div>
          )
        ) : drift.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-muted-foreground">{reps.length ? "Every tracked source matches your approved facts." : "No sources are tracked yet."}</p>
        ) : (
          <div className="space-y-1">
          {drift.slice(0, 6).map((r) => (
            <Link
              key={r.binding_id}
              to={`/businesses/${businessId}/representations/${r.binding_id}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-foreground/[0.03]"
            >
              <RepresentationStateBadge state={r.finding.state} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{sentenceCase(r.fact.predicate)}</span>{" "}
                <span className="text-muted-foreground">
                  shows {r.effective_observation?.extracted_value ?? "nothing yet"}, approved {r.fact.valueText}
                </span>
              </span>
              <ControlBadge control={r.source.control} />
            </Link>
          ))}
          </div>
        )}
      </div>
    </Panel>
  )
}

function QuestionsCard({ businessId, a, loading, days }: { businessId: string; a: Analytics | null; loading: boolean; days: number }) {
  const [tab, setTab] = useState<"questions" | "facts">("questions")
  return (
    <Panel className="shadow-(--card-shadow-raised)">
      <PanelHeader title="What buyers ask" description="Accuracy per question and per approved fact">
        <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
          <Link to={`/businesses/${businessId}/${tab === "questions" ? "checks" : "truth"}`}>
            {tab === "questions" ? "Manage questions" : "Approved facts"}
            <ArrowRightIcon />
          </Link>
        </Button>
      </PanelHeader>
      <div className="px-4 pt-2">
        <Tabs value={tab} onValueChange={(v) => setTab(v as "questions" | "facts")}>
          <TabsList>
            <TabsTrigger value="questions">Questions</TabsTrigger>
            <TabsTrigger value="facts">Facts</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="p-2">
        {loading || !a ? (
          <ListSkeleton />
        ) : tab === "questions" ? (
          a.questions.length === 0 ? (
            <p className="px-2 py-8 text-center text-xs text-muted-foreground">No buyer questions yet. Add the questions prospects ask, then run checks.</p>
          ) : (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_6rem_3rem_3rem] gap-3 px-2 pb-1 text-[11px] text-muted-foreground">
                <span>Question</span>
                <span>Verdicts</span>
                <span className="text-right">Accurate</span>
                <span className="text-right">Checks</span>
              </div>
              {a.questions.map((q) => (
                <div key={q.id} className="grid grid-cols-[minmax(0,1fr)_6rem_3rem_3rem] items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.03]">
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{q.label || q.prompt}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{q.last_checked_at ? `Last asked ${relativeTime(q.last_checked_at)}` : "Never asked"}</span>
                  </span>
                  <VerdictBar counts={q} className="h-1.5" />
                  <span className="text-right text-xs font-medium tabular-nums">{pct(accuracy(q))}</span>
                  <span className="text-right text-xs text-muted-foreground tabular-nums">{q.checks}</span>
                </div>
              ))}
            </>
          )
        ) : a.facts.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-muted-foreground">No reviewed claims were linked to an approved fact in the last {days} days.</p>
        ) : (
          <>
            <div className="grid grid-cols-[minmax(0,1fr)_6rem_3rem_3rem] gap-3 px-2 pb-1 text-[11px] text-muted-foreground">
              <span>Approved fact</span>
              <span>Verdicts</span>
              <span className="text-right">Accurate</span>
              <span className="text-right">Wrong</span>
            </div>
            {a.facts.map((f) => (
              <div key={f.id} className="grid grid-cols-[minmax(0,1fr)_6rem_3rem_3rem] items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-foreground/[0.03]">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">{sentenceCase(f.predicate)}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    Approved {f.value_text}
                    {f.status !== "ACTIVE" ? ` · ${sentenceCase(f.status).toLowerCase()}` : ""}
                  </span>
                </span>
                <VerdictBar counts={f} className="h-1.5" />
                <span className="text-right text-xs font-medium tabular-nums">{pct(accuracy(f))}</span>
                <span className="text-right text-xs text-muted-foreground tabular-nums">{f.wrong}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </Panel>
  )
}

function ListSkeleton() {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-6" />
      ))}
    </div>
  )
}

function ChartEmpty({ days, what }: { days: number; what: string }) {
  return (
    <div className="flex h-[280px] flex-col items-center justify-center rounded-xl border border-dashed text-center">
      <p className="text-xs font-medium">
        No {what} in the last {days} days
      </p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">Try a longer period, or run a check to collect fresh answers.</p>
    </div>
  )
}

function downloadCsv(a: Analytics, businessName: string) {
  const header = ["date", "checks", "failed", "supported", "wrong", "partially_correct", "not_enough_information", "waiting_for_review"]
  const rows = a.daily.map((d) => [d.date, d.checks, d.failed, d.supported, d.wrong, d.partial, d.unknown, d.unreviewed])
  const csv = [header, ...rows].map((r) => r.join(",")).join("\n")
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }))
  const link = document.createElement("a")
  link.href = url
  link.download = `openrecord-${businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${a.range.days}d.csv`
  link.click()
  URL.revokeObjectURL(url)
}

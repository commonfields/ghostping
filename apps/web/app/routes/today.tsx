import { useMemo } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import { ArrowDownRightIcon, ArrowRightIcon, ArrowUpRightIcon, BarChart3Icon, DownloadIcon, MinusIcon, RadarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Legend, StackedDailyChart, Swatch, VerdictBar, totalClaims, verdictSeries } from "@/components/charts"
import { EmptyState } from "@/components/page"
import { AnalyticsApi, type Analytics, type VerdictCounts } from "@/lib/api"
import { errorMessage, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

const periods = [7, 30, 90] as const
type Period = (typeof periods)[number]

const providerName = (p: string) => (p === "9router" ? "9Router" : sentenceCase(p))

function shortDate(iso: string): string {
  // Day buckets are UTC dates (YYYY-MM-DD); render them without shifting.
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
}

export function Today() {
  const { id = "" } = useParams()
  const { activeBusiness } = useWorkspace()
  const [params, setParams] = useSearchParams()
  const days: Period = periods.includes(Number(params.get("days")) as Period) ? (Number(params.get("days")) as Period) : 30
  const { data, loading, error } = useApi(`analytics:${id}:${days}`, () => AnalyticsApi.get(id, days))
  const a = data?.analytics ?? null

  const setDays = (d: string) => {
    const next = new URLSearchParams(params)
    next.set("days", d)
    setParams(next, { replace: true })
  }

  return (
    <div className="space-y-6 pb-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">How AI describes {activeBusiness?.name ?? "this business"}</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            What AI assistants said in collected answers, and how each claim compares with your approved facts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={String(days)} onValueChange={setDays}>
            <TabsList>
              {periods.map((p) => (
                <TabsTrigger key={p} value={String(p)}>
                  {p} days
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button variant="outline" disabled={!a} onClick={() => a && downloadCsv(a, activeBusiness?.name ?? "business")}>
            <DownloadIcon />
            Export CSV
          </Button>
          <Button asChild>
            <Link to={`/businesses/${id}/checks`}>
              <RadarIcon />
              Run a check
            </Link>
          </Button>
        </div>
      </div>

      {error && !a ? (
        <EmptyState icon={<BarChart3Icon />} title="Analytics could not load" description={errorMessage(error)} />
      ) : (
        <>
          <KpiStrip a={a} loading={loading} />

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="shadow-(--float-shadow) lg:col-span-2">
              <CardHeader>
                <CardTitle>Claims by day</CardTitle>
                <CardDescription>Statements transcribed from AI answers, by the verdict they received.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {loading || !a ? (
                  <Skeleton className="h-[260px]" />
                ) : totalClaims(a.current) === 0 ? (
                  <ChartEmpty days={days} what="claims" />
                ) : (
                  <>
                    <Legend items={verdictSeries.map((s) => ({ label: s.label, cssVar: s.cssVar }))} />
                    <StackedDailyChart data={a.daily} series={verdictSeries} formatDate={shortDate} height={240} />
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-(--float-shadow)">
              <CardHeader>
                <CardTitle>Verdict mix</CardTitle>
                <CardDescription>All claims from the last {days} days.</CardDescription>
              </CardHeader>
              <CardContent>
                {loading || !a ? <Skeleton className="h-[260px]" /> : <VerdictMix counts={a.current} />}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card className="shadow-(--float-shadow) lg:col-span-2">
              <CardHeader>
                <CardTitle>By AI provider</CardTitle>
                <CardDescription>Where answers came from and how their claims were judged.</CardDescription>
              </CardHeader>
              <CardContent className="px-0">
                {loading || !a ? (
                  <div className="px-5">
                    <Skeleton className="h-32" />
                  </div>
                ) : a.providers.length === 0 ? (
                  <div className="px-5">
                    <ChartEmpty days={days} what="answers" />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="pl-5">Provider</TableHead>
                        <TableHead className="text-right">Answers</TableHead>
                        <TableHead className="text-right">Claims</TableHead>
                        <TableHead className="w-[32%]">Mix</TableHead>
                        <TableHead className="text-right">Wrong</TableHead>
                        <TableHead className="pr-5 text-right">Partial</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {a.providers.map((p) => (
                        <TableRow key={p.provider}>
                          <TableCell className="pl-5 font-medium">{providerName(p.provider)}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.answers}</TableCell>
                          <TableCell className="text-right tabular-nums">{totalClaims(p)}</TableCell>
                          <TableCell>
                            <VerdictBar counts={p} />
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.wrong}</TableCell>
                          <TableCell className="pr-5 text-right tabular-nums">{p.partial}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>

            <Card className="shadow-(--float-shadow)">
              <CardHeader>
                <CardTitle>Checks per day</CardTitle>
                <CardDescription>
                  {a ? `${a.current.checks} run, ${a.current.failed} failed` : "Runs sent to AI providers"}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {loading || !a ? (
                  <Skeleton className="h-[180px]" />
                ) : a.current.checks === 0 ? (
                  <ChartEmpty days={days} what="checks" />
                ) : (
                  <>
                    <Legend
                      items={[
                        { label: "Failed", cssVar: "--chart-wrong" },
                        { label: "Answered", cssVar: "--chart-checks" },
                      ]}
                    />
                    <StackedDailyChart
                      data={a.daily.map((d) => ({ date: d.date, failed: d.failed, answered: d.checks - d.failed }))}
                      series={[
                        { key: "failed", label: "Failed", cssVar: "--chart-wrong" },
                        { key: "answered", label: "Answered", cssVar: "--chart-checks" },
                      ]}
                      formatDate={shortDate}
                      height={170}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="shadow-(--float-shadow)">
            <CardHeader>
              <CardTitle>Buyer questions</CardTitle>
              <CardDescription>Which questions lead AI assistants to say something wrong about you. Sorted by wrong claims.</CardDescription>
              <CardAction>
                <Button asChild variant="outline" size="sm">
                  <Link to={`/businesses/${id}/checks`}>
                    Manage questions
                    <ArrowRightIcon />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="px-0">
              {loading || !a ? (
                <div className="px-5">
                  <Skeleton className="h-32" />
                </div>
              ) : a.questions.length === 0 ? (
                <div className="px-5">
                  <EmptyState
                    icon={<RadarIcon />}
                    title="No buyer questions yet"
                    description="Add the questions prospects ask, then run checks to see how AI assistants answer them."
                    className="py-10"
                  />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-5">Question</TableHead>
                      <TableHead className="text-right">Checks</TableHead>
                      <TableHead>Last answer</TableHead>
                      <TableHead className="w-[22%]">Mix</TableHead>
                      <TableHead className="text-right">Wrong</TableHead>
                      <TableHead className="text-right">Partial</TableHead>
                      <TableHead className="pr-5 text-right">Waiting</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {a.questions.map((q) => (
                      <TableRow key={q.id}>
                        <TableCell className="max-w-[26rem] pl-5">
                          <div className="truncate font-medium">{q.label || q.prompt}</div>
                          {q.label ? <div className="truncate text-xs text-muted-foreground">{q.prompt}</div> : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{q.checks}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{q.last_checked_at ? relativeTime(q.last_checked_at) : "Never"}</TableCell>
                        <TableCell>
                          <VerdictBar counts={q} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{q.wrong}</TableCell>
                        <TableCell className="text-right tabular-nums">{q.partial}</TableCell>
                        <TableCell className="pr-5 text-right tabular-nums">{q.unreviewed}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-(--float-shadow)">
            <CardHeader>
              <CardTitle>Facts AI gets wrong</CardTitle>
              <CardDescription>Approved facts linked to reviewed claims. Start corrections and content updates here.</CardDescription>
              <CardAction>
                <Button asChild variant="outline" size="sm">
                  <Link to={`/businesses/${id}/facts`}>
                    Approved facts
                    <ArrowRightIcon />
                  </Link>
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              {loading || !a ? (
                <Skeleton className="h-24" />
              ) : a.facts.length === 0 ? (
                <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                  No reviewed claims were linked to an approved fact in the last {days} days. Link facts when you record a verdict to see them here.
                </p>
              ) : (
                <ul className="divide-y rounded-lg border">
                  {a.facts.map((f) => (
                    <li key={f.id} className="grid items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto]">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{sentenceCase(f.predicate)}</div>
                        <div className="truncate text-xs text-muted-foreground">
                          Approved value {f.value_text}
                          {f.status !== "ACTIVE" ? `, ${sentenceCase(f.status).toLowerCase()}` : ""}
                        </div>
                      </div>
                      <VerdictBar counts={f} />
                      <div className="flex gap-4 text-sm tabular-nums sm:justify-end">
                        <span>
                          <span className="font-medium">{f.wrong}</span> <span className="text-muted-foreground">wrong</span>
                        </span>
                        <span>
                          <span className="font-medium">{f.partial}</span> <span className="text-muted-foreground">partial</span>
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function KpiStrip({ a, loading }: { a: Analytics | null; loading: boolean }) {
  const reviewed = (c: VerdictCounts) => c.supported + c.wrong + c.partial + c.unknown
  const items = useMemo(() => {
    if (!a) return null
    const d = a.range.days
    return [
      { label: "Answers collected", value: a.current.answers, prev: a.previous.answers, goodWhenUp: true, hint: `${a.current.checks} checks run` },
      { label: "Claims reviewed", value: reviewed(a.current), prev: reviewed(a.previous), goodWhenUp: true, hint: `${totalClaims(a.current)} transcribed` },
      { label: "Wrong", value: a.current.wrong, prev: a.previous.wrong, goodWhenUp: false, cssVar: "--chart-wrong", hint: null },
      { label: "Partially correct", value: a.current.partial, prev: a.previous.partial, goodWhenUp: false, cssVar: "--chart-partial", hint: null },
      { label: "Waiting for review", value: a.current.unreviewed, prev: a.previous.unreviewed, goodWhenUp: false, cssVar: "--chart-unreviewed", hint: null },
    ].map((i) => ({ ...i, days: d }))
  }, [a])

  return (
    <Card className="gap-0 py-0 shadow-(--float-shadow)">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
        {(items ?? Array.from({ length: 5 }, () => null)).map((i, idx) => (
          <div key={idx} className="border-b border-border p-5 lg:border-b-0 [&:not(:last-child)]:border-r max-sm:[&:nth-child(2n)]:border-r-0 sm:max-lg:[&:nth-child(3n)]:border-r-0">
            {loading || !i ? (
              <div className="space-y-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-7 w-12" />
                <Skeleton className="h-3 w-28" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  {i.cssVar ? <Swatch cssVar={i.cssVar} className="size-2" /> : null}
                  {i.label}
                </div>
                <div className="mt-2 text-[28px] leading-none font-semibold tracking-tight tabular-nums">{i.value}</div>
                <Delta value={i.value} prev={i.prev} goodWhenUp={i.goodWhenUp} days={i.days} />
              </>
            )}
          </div>
        ))}
      </div>
    </Card>
  )
}

function Delta({ value, prev, goodWhenUp, days }: { value: number; prev: number; goodWhenUp: boolean; days: number }) {
  const diff = value - prev
  if (diff === 0) {
    return (
      <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
        <MinusIcon className="size-3.5" />
        Same as previous {days} days
      </div>
    )
  }
  const up = diff > 0
  const good = up === goodWhenUp
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
      <span className={cn("inline-flex items-center gap-0.5 font-medium", good ? "text-supported" : "text-wrong")}>
        <Icon className="size-3.5" />
        {up ? "+" : ""}
        {diff}
      </span>
      vs previous {days} days
    </div>
  )
}

function VerdictMix({ counts }: { counts: VerdictCounts }) {
  const total = totalClaims(counts)
  if (total === 0) {
    return <p className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">No claims in this period yet.</p>
  }
  return (
    <div className="space-y-5">
      <div>
        <div className="text-[28px] leading-none font-semibold tracking-tight tabular-nums">{total}</div>
        <div className="mt-1 text-sm text-muted-foreground">claims transcribed</div>
      </div>
      <VerdictBar counts={counts} className="h-3" />
      <ul className="space-y-2.5">
        {[...verdictSeries].reverse().map((s) => {
          const n = counts[s.key]
          return (
            <li key={s.key} className="flex items-center gap-2.5 text-sm">
              <Swatch cssVar={s.cssVar} />
              <span className="flex-1 text-muted-foreground">{s.label}</span>
              <span className="font-medium tabular-nums">{n}</span>
              <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{Math.round((n / total) * 100)}%</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ChartEmpty({ days, what }: { days: number; what: string }) {
  return (
    <div className="flex h-[200px] flex-col items-center justify-center rounded-lg border border-dashed text-center">
      <p className="text-sm font-medium">No {what} in the last {days} days</p>
      <p className="mt-1 max-w-xs text-sm text-muted-foreground">Try a longer period, or run a check to collect fresh answers.</p>
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
  link.download = `ghostping-${businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${a.range.days}d.csv`
  link.click()
  URL.revokeObjectURL(url)
}

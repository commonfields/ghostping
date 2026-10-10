import { useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { ArrowUpRightIcon, ChevronRightIcon, MessageCircleQuestionIcon, PlayIcon, PlusIcon, RadarIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EmptyState, PageHeader, Panel, PanelHeader, StatStrip } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { ProviderChip, RunStatusBadge } from "@/components/status"
import { VerdictBar } from "@/components/charts"
import { AnalyticsApi, Checks, Providers, Questions, type CheckRun, type VerdictCounts } from "@/lib/api"
import { errorMessage, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { usePreferences } from "@/lib/preferences"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

type Provider = "mock" | "9router"
const providers: Array<{ value: Provider; label: string }> = [
  { value: "mock", label: "Mock (test answers)" },
  { value: "9router", label: "9Router (live model)" },
]

const failureHelp = (failureClass: string | null): string | null => {
  if (failureClass === "PROVIDER_UNSUPPORTED") return "The selected provider or model is unavailable for this request. Pick a configured 9Router model."
  if (failureClass === "WORKER_LOST") return "The worker stopped before this check finished, so nothing was observed. Run the check again for a fresh answer."
  return null
}

const origins = ["BUSINESS_OWNER", "SALES", "SUPPORT", "CUSTOMER_INTERVIEW", "SEARCH_DATA", "OPERATOR_CONSTRUCTED", "OTHER"] as const

const HISTORY_PAGE = 25

const reviewedOf = (c: VerdictCounts) => c.supported + c.wrong + c.partial + c.unknown
const pct = (c: VerdictCounts) => (reviewedOf(c) ? `${Math.round((c.supported / reviewedOf(c)) * 100)}%` : "—")

/** "Today", "Yesterday", or a short date, for grouping the activity feed. */
function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(today) - start(d)) / 86400000)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
}

export function ChecksPage() {
  const { id = "" } = useParams()
  const { reloadOverview } = useWorkspace()
  const questions = useApi(`questions:${id}`, () => Questions.list(id))
  const analytics = useApi(`analytics:${id}:30`, () => AnalyticsApi.get(id, 30))
  const providerInfo = useApi("providers", () => Providers.list())
  const { preferences } = usePreferences()
  const [provider, setProvider] = useState<Provider>(preferences.defaultProvider)
  const [model, setModel] = useState<string>("")
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set())
  const [addOpen, setAddOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [historyFilter, setHistoryFilter] = useState<"all" | "active" | "failed">("all")
  const [historyShown, setHistoryShown] = useState(HISTORY_PAGE)

  const nineRouter = providerInfo.data?.providers.find((p) => p.id === "9router") ?? null
  const nineModels = nineRouter?.models ?? []
  const nineEnabled = nineRouter?.enabled === true && nineModels.length > 0
  const effectiveModel = model || nineModels[0] || ""
  const needModel = provider === "9router" && !effectiveModel

  const [active, setActive] = useState(false)
  const runs = useApi(`runs:${id}`, () =>
    Checks.list(id).then((r) => {
      setActive(r.checkRuns.some((c) => c.status === "QUEUED" || c.status === "RUNNING"))
      return r
    }),
    { pollMs: active ? 2000 : null },
  )

  const questionList = useMemo(() => questions.data?.questions ?? [], [questions.data])
  const promptById = useMemo(() => new Map(questionList.map((q) => [q.id, q.label || q.prompt])), [questionList])
  const statsByQuestion = useMemo(() => new Map((analytics.data?.analytics.questions ?? []).map((q) => [q.id, q])), [analytics.data])
  const runList = useMemo(() => [...(runs.data?.checkRuns ?? [])].sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1)), [runs.data])
  const runsByQuestion = useMemo(() => {
    const m = new Map<string, CheckRun[]>()
    for (const r of runList) m.set(r.questionId, [...(m.get(r.questionId) ?? []), r])
    return m
  }, [runList])
  const counts = useMemo(
    () => ({
      active: runList.filter((r) => r.status === "QUEUED" || r.status === "RUNNING").length,
      failed: runList.filter((r) => r.status === "FAILED").length,
      answered: runList.filter((r) => r.observationId).length,
    }),
    [runList],
  )
  const filteredRuns = runList.filter((r) =>
    historyFilter === "all" ? true : historyFilter === "failed" ? r.status === "FAILED" : r.status === "QUEUED" || r.status === "RUNNING",
  )
  const shownRuns = filteredRuns.slice(0, historyShown)
  const days: Array<[string, CheckRun[]]> = []
  for (const r of shownRuns) {
    const label = dayLabel(r.queuedAt)
    const last = days.at(-1)
    if (last && last[0] === label) last[1].push(r)
    else days.push([label, [r]])
  }

  const a = analytics.data?.analytics ?? null

  const runChecks = async (questionIds: string[]) => {
    if (provider === "9router" && !effectiveModel) {
      toast.error("No live model is configured", { description: "Set NINE_ROUTER_MODELS on the server, or use Mock." })
      return
    }
    setRunning((s) => new Set([...s, ...questionIds]))
    let queued = 0
    for (const q of questionIds) {
      try {
        await Checks.run(id, q, provider, provider === "9router" ? effectiveModel : null)
        queued += 1
      } catch (err) {
        toast.error("Could not queue the check", { description: errorMessage(err) })
      } finally {
        setRunning((s) => {
          const next = new Set(s)
          next.delete(q)
          return next
        })
      }
    }
    if (queued) {
      toast.success(queued === 1 ? "Check queued" : `${queued} checks queued`, { description: "The worker will collect the answers in a moment." })
      setActive(true)
      await runs.reload()
      reloadOverview()
    }
  }

  const loadingValue = <Skeleton className="h-4 w-8" />

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Checks"
        description="Ask AI models your buyers' questions and keep every answer as evidence. Checks never change approved truth."
        actions={
          <>
            <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
              <SelectTrigger aria-label="Provider" className="h-8 w-[11rem] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {providers.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {provider === "9router" && nineModels.length > 0 ? (
              <Select value={effectiveModel} onValueChange={setModel}>
                <SelectTrigger aria-label="Model" className="h-8 w-[10rem] text-xs">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent align="end">
                  {nineModels.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button variant="outline" size="sm" disabled={questionList.length === 0 || needModel || running.size > 0} onClick={() => void runChecks(questionList.map((q) => q.id))}>
              {running.size > 0 ? <Spinner /> : <PlayIcon />}
              Run all
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Add question
            </Button>
          </>
        }
      />

      <StatStrip
        stats={[
          { key: "q", label: "Buyer questions", value: questions.loading ? loadingValue : questionList.length, hint: "Asked on every run" },
          { key: "checks", label: "Checks, 30 days", value: a ? a.current.checks.toLocaleString() : loadingValue, hint: a ? `${a.previous.checks.toLocaleString()} the 30 days before` : "Loading" },
          { key: "acc", label: "Answer accuracy", value: a ? pct(a.current) : loadingValue, hint: a ? `${reviewedOf(a.current).toLocaleString()} claims reviewed` : "Loading", tone: "supported" },
          { key: "active", label: "In progress", value: runs.loading ? loadingValue : counts.active, hint: counts.active ? "Updating live" : "Nothing queued", tone: "review" },
          { key: "failed", label: "Failed", value: runs.loading ? loadingValue : counts.failed, hint: "Hover a run for the reason", tone: "wrong" },
        ]}
      />

      {provider === "9router" && !providerInfo.loading && !nineEnabled ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle className="font-normal">Live checks are unavailable: the server has no 9Router model allowlist. Queued 9Router runs will fail closed.</AlertTitle>
        </Alert>
      ) : null}

      <Panel>
        <PanelHeader title="Buyer questions" description="How AI models answered each question over the last 30 days" />
        {questions.loading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : questionList.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<MessageCircleQuestionIcon />}
              title="No buyer questions yet"
              description="Start with the questions prospects ask your sales team, like pricing, integrations or cancellation terms."
              action={
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <PlusIcon />
                  Add question
                </Button>
              }
              className="py-10"
            />
          </div>
        ) : (
          <>
            <div className="mt-2 hidden grid-cols-[1rem_minmax(0,1fr)_8rem_4rem_4rem_6rem_7rem_4.5rem] items-center gap-x-4 border-y bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground lg:grid">
              <span />
              <span>Question</span>
              <span>Verdicts, 30 days</span>
              <span className="text-right">Accurate</span>
              <span className="text-right">Checks</span>
              <span>Last asked</span>
              <span>Last run</span>
              <span />
            </div>
            <ul className="divide-y">
              {questionList.map((q) => {
                const st = statsByQuestion.get(q.id)
                const qRuns = runsByQuestion.get(q.id) ?? []
                const last = qRuns[0]
                const open = expanded === q.id
                return (
                  <li key={q.id} className={cn(open && "bg-muted/25")}>
                    <div className="grid items-center gap-x-4 gap-y-2 px-4 py-2.5 text-xs lg:grid-cols-[1rem_minmax(0,1fr)_8rem_4rem_4rem_6rem_7rem_4.5rem]">
                      <button type="button" aria-label={open ? "Hide answers" : "Show answers"} aria-expanded={open} onClick={() => setExpanded(open ? null : q.id)} className="hidden text-muted-foreground hover:text-foreground lg:block">
                        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                      </button>
                      <button type="button" onClick={() => setExpanded(open ? null : q.id)} className="min-w-0 text-left">
                        <span className="block font-medium">{q.prompt}</span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                          {q.label ? <span className="rounded-full bg-muted px-1.5 font-medium text-foreground">{q.label}</span> : null}
                          <span>From {sentenceCase(q.origin).toLowerCase()}</span>
                        </span>
                      </button>
                      <span>{st ? <VerdictBar counts={st} className="h-1.5" /> : <span className="text-[11px] text-muted-foreground">No answers</span>}</span>
                      <span className="text-right font-medium tabular-nums">{st ? pct(st) : "—"}</span>
                      <span className="text-right text-muted-foreground tabular-nums">{st?.checks ?? 0}</span>
                      <span className="text-muted-foreground" title={last ? formatDateTime(last.queuedAt) : undefined}>
                        {last ? relativeTime(last.queuedAt) : "Never"}
                      </span>
                      <span>{last ? <RunStatusBadge status={last.status} /> : null}</span>
                      <span className="text-right">
                        <Button variant="outline" size="sm" className="h-7 px-2 text-xs" onClick={() => void runChecks([q.id])} disabled={running.has(q.id) || needModel}>
                          {running.has(q.id) ? <Spinner /> : <PlayIcon />}
                          Run
                        </Button>
                      </span>
                    </div>
                    {open ? (
                      <div className="px-4 pb-3 lg:pl-12">
                        {qRuns.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground">Not asked yet. Run it to collect the first answer.</p>
                        ) : (
                          <ul className="overflow-hidden rounded-lg bg-card shadow-(--card-shadow)">
                            {qRuns.slice(0, 6).map((r) => (
                              <RunRow key={r.id} run={r} />
                            ))}
                          </ul>
                        )}
                        <div className="mt-2 flex gap-3 text-[11px]">
                          <Link to={`/businesses/${id}/issues?view=answers&q=${encodeURIComponent(q.prompt)}`} className="font-medium text-foreground hover:underline">
                            Issues from this question
                          </Link>
                          {qRuns.length > 6 ? <span className="text-muted-foreground">{qRuns.length - 6} older runs in the activity below</span> : null}
                        </div>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </Panel>

      <Panel>
        <PanelHeader
          title={
            <span className="flex items-center gap-2">
              Activity
              {active ? <Spinner className="size-3.5 text-muted-foreground" /> : null}
            </span>
          }
          description="Every check keeps its answer. Failed runs show why they stopped."
        >
          <Tabs
            value={historyFilter}
            onValueChange={(v) => {
              setHistoryFilter(v as typeof historyFilter)
              setHistoryShown(HISTORY_PAGE)
            }}
          >
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="active">In progress {counts.active ? <span className="tabular-nums">{counts.active}</span> : null}</TabsTrigger>
              <TabsTrigger value="failed">Failed {counts.failed ? <span className="tabular-nums">{counts.failed}</span> : null}</TabsTrigger>
            </TabsList>
          </Tabs>
        </PanelHeader>
        <div className="p-2">
          {runs.loading ? (
            <Skeleton className="m-2 h-32" />
          ) : filteredRuns.length === 0 ? (
            <EmptyState
              icon={<RadarIcon />}
              title={runList.length === 0 ? "No checks have run" : "Nothing here"}
              description={runList.length === 0 ? "Run a buyer question. Results appear here as soon as the worker picks them up." : "No runs match this filter."}
              className="m-2 py-10"
            />
          ) : (
            <>
              {days.map(([label, list]) => (
                <div key={label} className="pb-1">
                  <div className="flex items-center justify-between px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
                    <span className="font-medium">{label}</span>
                    <span className="tabular-nums">{list.length}</span>
                  </div>
                  <ul>
                    {list.map((r) => (
                      <RunRow key={r.id} run={r} prompt={promptById.get(r.questionId) ?? "Removed question"} />
                    ))}
                  </ul>
                </div>
              ))}
              {filteredRuns.length > historyShown ? (
                <div className="flex items-center justify-between px-2 pt-1 text-[11px] text-muted-foreground">
                  <span>
                    Showing {historyShown} of {filteredRuns.length.toLocaleString()}
                  </span>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setHistoryShown((n) => n + HISTORY_PAGE * 2)}>
                    Show more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </Panel>

      <AddQuestionDialog businessId={id} open={addOpen} onOpenChange={setAddOpen} onCreated={() => void questions.reload()} />
    </div>
  )
}

function RunRow({ run: r, prompt }: { run: CheckRun; prompt?: string }) {
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_4.5rem_6rem] items-center gap-3 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-muted/40">
      <span className="flex min-w-0 items-center gap-2">
        <ProviderChip provider={r.provider} className="shrink-0" />
        {prompt ? <span className="truncate text-muted-foreground">{prompt}</span> : null}
      </span>
      {r.status === "FAILED" && (r.failureClass || r.failureDetailSafe) ? (
        <Tooltip>
          <TooltipTrigger className="cursor-help rounded-md outline-none">
            <RunStatusBadge status={r.status} />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            {r.failureClass ? sentenceCase(r.failureClass) : "Failed"}
            {r.failureDetailSafe ? `: ${r.failureDetailSafe}` : ""}
            {r.attemptCount > 1 ? ` (after ${r.attemptCount} attempts)` : ""}
            {failureHelp(r.failureClass) ? ` ${failureHelp(r.failureClass)}` : ""}
          </TooltipContent>
        </Tooltip>
      ) : (
        <RunStatusBadge status={r.status} />
      )}
      <span className="text-right text-muted-foreground tabular-nums" title={formatDateTime(r.queuedAt)}>
        {relativeTime(r.queuedAt)}
      </span>
      <span className="text-right">
        {r.observationId ? (
          <Link to={`/observations/${r.observationId}`} className="inline-flex items-center gap-0.5 font-medium hover:underline">
            View answer
            <ArrowUpRightIcon className="size-3.5 text-muted-foreground" />
          </Link>
        ) : (
          <span className="text-muted-foreground">{r.status === "FAILED" ? "No answer" : "Waiting"}</span>
        )}
      </span>
    </li>
  )
}

function AddQuestionDialog({
  businessId,
  open,
  onOpenChange,
  onCreated,
}: {
  businessId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const [prompt, setPrompt] = useState("")
  const [label, setLabel] = useState("")
  const [origin, setOrigin] = useState<string>("BUSINESS_OWNER")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setPrompt("")
    setLabel("")
    setOrigin("BUSINESS_OWNER")
    setError(null)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            setPending(true)
            setError(null)
            Questions.create(businessId, { prompt, label: label.trim() || null, origin })
              .then(() => {
                toast.success("Question added")
                onCreated()
                onOpenChange(false)
                reset()
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setPending(false))
          }}
        >
          <DialogHeader>
            <DialogTitle>Add buyer question</DialogTitle>
            <DialogDescription>Write it the way a prospect would ask an AI assistant.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="q-prompt">Question</Label>
            <Textarea
              id="q-prompt"
              autoFocus
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.currentTarget.value)}
              placeholder="How much does Northstar cost per month?"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="q-label">Short label</Label>
              <Input id="q-label" value={label} onChange={(e) => setLabel(e.currentTarget.value)} placeholder="Pricing" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="q-origin">Where it came from</Label>
              <Select value={origin} onValueChange={setOrigin}>
                <SelectTrigger id="q-origin">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {origins.map((o) => (
                    <SelectItem key={o} value={o}>
                      {sentenceCase(o)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {error ? <p className="text-xs text-wrong">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !prompt.trim()}>
              {pending ? <Spinner /> : null}
              Add question
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

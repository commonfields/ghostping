import { useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { ArrowUpRightIcon, MessageCircleQuestionIcon, PlayIcon, PlusIcon, RadarIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EmptyState, PageHeader } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { RunStatusBadge } from "@/components/status"
import { Checks, Providers, Questions } from "@/lib/api"
import { errorMessage, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { usePreferences } from "@/lib/preferences"
import { useWorkspace } from "@/lib/workspace"

type Provider = "mock" | "9router"
const providers: Array<{ value: Provider; label: string }> = [
  { value: "mock", label: "Mock (test answers)" },
  { value: "9router", label: "9Router (live model)" },
]

const failureHelp = (failureClass: string | null): string | null => {
  if (failureClass === "PROVIDER_UNSUPPORTED") return "The selected provider or model is unavailable for this request. Pick a configured 9Router model."
  return null
}

const origins = ["BUSINESS_OWNER", "SALES", "SUPPORT", "CUSTOMER_INTERVIEW", "SEARCH_DATA", "OPERATOR_CONSTRUCTED", "OTHER"] as const

export function ChecksPage() {
  const { id = "" } = useParams()
  const { reloadOverview } = useWorkspace()
  const questions = useApi(`questions:${id}`, () => Questions.list(id))
  const providerInfo = useApi("providers", () => Providers.list())
  const { preferences } = usePreferences()
  const [provider, setProvider] = useState<Provider>(preferences.defaultProvider)
  const [model, setModel] = useState<string>("")
  const [running, setRunning] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)

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

  const promptById = useMemo(() => new Map((questions.data?.questions ?? []).map((q) => [q.id, q.label || q.prompt])), [questions.data])
  const runList = runs.data?.checkRuns ?? []

  const runCheck = (questionId: string) => {
    if (provider === "9router" && !effectiveModel) {
      toast.error("No live model is configured", { description: "Set NINE_ROUTER_MODELS on the server, or use Mock." })
      return
    }
    setRunning(questionId)
    Checks.run(id, questionId, provider, provider === "9router" ? effectiveModel : null)
      .then(() => {
        toast.success("Check queued", { description: "The worker will collect the answer in a moment." })
        setActive(true)
        return runs.reload()
      })
      .then(() => reloadOverview())
      .catch((err: unknown) => toast.error("Could not queue the check", { description: errorMessage(err) }))
      .finally(() => setRunning(null))
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Checks"
        description="Collect fresh AI observations to review. Checks record answers as evidence; they do not change approved truth."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <PlusIcon />
            Add question
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Buyer questions</CardTitle>
          <CardDescription>Run a question to collect a fresh answer from the selected provider.</CardDescription>
          <CardAction className="flex w-72 flex-col gap-2">
            <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
              <SelectTrigger aria-label="Provider">
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
            {provider === "9router" ? (
              nineModels.length > 0 ? (
                <Select value={effectiveModel} onValueChange={setModel}>
                  <SelectTrigger aria-label="Model">
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
              ) : (
                <p className="text-xs text-muted-foreground">
                  {providerInfo.loading ? "Loading configured models…" : "No live model is configured on the server. Use Mock, or set NINE_ROUTER_MODELS."}
                </p>
              )
            ) : null}
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-4">
          {provider === "9router" && !providerInfo.loading && !nineEnabled ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle className="font-normal">Live checks are unavailable: the server has no 9Router model allowlist. Queued 9Router runs will fail closed.</AlertTitle>
            </Alert>
          ) : null}
          {questions.loading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : (questions.data?.questions.length ?? 0) === 0 ? (
            <EmptyState
              icon={<MessageCircleQuestionIcon />}
              title="No buyer questions yet"
              description="Start with the questions prospects ask your sales team, like pricing, integrations or cancellation terms."
              action={
                <Button onClick={() => setAddOpen(true)}>
                  <PlusIcon />
                  Add question
                </Button>
              }
              className="py-10"
            />
          ) : (
            <ul className="divide-y rounded-lg border">
              {questions.data?.questions.map((q) => (
                <li key={q.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{q.prompt}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {q.label ? `${q.label}, from ` : "From "}
                      {sentenceCase(q.origin).toLowerCase()}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => runCheck(q.id)} disabled={running === q.id || needModel}>
                    {running === q.id ? <Spinner /> : <PlayIcon />}
                    Run check
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Run history
            {active ? <Spinner className="text-muted-foreground" /> : null}
          </CardTitle>
          <CardDescription>Every check keeps its answer. Failed runs show why they stopped.</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.loading ? (
            <Skeleton className="h-32" />
          ) : runList.length === 0 ? (
            <EmptyState
              icon={<RadarIcon />}
              title="No checks have run"
              description="Run a buyer question above. Results appear here as soon as the worker picks them up."
              className="py-10"
            />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Question</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Queued</TableHead>
                    <TableHead className="text-right">Answer</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runList.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-[22rem]">
                        <span className="line-clamp-1">{promptById.get(r.questionId) ?? "Removed question"}</span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.provider === "9router" ? "9Router" : sentenceCase(r.provider)}</TableCell>
                      <TableCell>
                        {r.status === "FAILED" && (r.failureClass || r.failureDetailSafe) ? (
                          <Tooltip>
                            <TooltipTrigger className="cursor-help rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring">
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
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        <Tooltip>
                          <TooltipTrigger className="cursor-default">{relativeTime(r.queuedAt)}</TooltipTrigger>
                          <TooltipContent>{formatDateTime(r.queuedAt)}</TooltipContent>
                        </Tooltip>
                      </TableCell>
                      <TableCell className="text-right">
                        {r.observationId ? (
                          <Button asChild variant="ghost" size="sm">
                            <Link to={`/observations/${r.observationId}`}>
                              View answer
                              <ArrowUpRightIcon />
                            </Link>
                          </Button>
                        ) : (
                          <span className="text-sm text-muted-foreground">{r.status === "FAILED" ? "No answer" : "Waiting"}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <AddQuestionDialog
        businessId={id}
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => void questions.reload()}
      />
    </div>
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
          {error ? <p className="text-sm text-wrong">{error}</p> : null}
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

import { useMemo, useState, type ReactNode } from "react"
import { Link, useLocation, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import {
  BookCheckIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileJsonIcon,
  LinkIcon,
  LoaderCircleIcon,
  MessageSquareQuoteIcon,
  PenLineIcon,
  PlusIcon,
  RefreshCwIcon,
  ScanSearchIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EmptyState, PageHeader, PanelHeader, domainOf } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { ControlBadge, IssueStateBadge, ProviderChip, RepresentationStateBadge, VerdictBadge, verdictLabel } from "@/components/status"
import {
  Interventions,
  Issues,
  Packets,
  Rechecks,
  Sources,
  type CitationEvidence,
  type Intervention,
  type IssueDetail,
  type IssueLoop,
  type IssueWithEvidence,
} from "@/lib/api"
import { filterIssues, readIssueQuery, sortAnswers } from "@/lib/issues"
import { errorMessage, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

export function IssueDetailPage() {
  const { id = "", claimId = "" } = useParams()
  const location = useLocation()
  const { reloadOverview } = useWorkspace()
  const { data, loading, error } = useApi(`issue:${claimId}`, () => Issues.get(id, claimId))
  const issue = data ?? null
  const all = useApi(`issues:${id}`, () => Issues.list(id))

  // One loop read feeds the timeline, the recheck form, and before/after, so
  // every action refreshes all three together. Poll while a recheck runs.
  const [polling, setPolling] = useState(false)
  const loopApi = useApi(
    `loop:${claimId}`,
    async () => {
      const r = await Rechecks.getLoop(id, claimId)
      setPolling(r.loop.reobservationAttempts.some((a) => a.state === "QUEUED" || a.state === "RUNNING" || a.state === "FINALIZING"))
      return r
    },
    { pollMs: polling ? 4000 : null },
  )
  const actionsApi = useApi(`interventions:${claimId}`, () => Interventions.list(id, claimId))
  const reload = async () => {
    await Promise.all([loopApi.reload(), actionsApi.reload()])
    reloadOverview()
  }

  const listSearch = location.search
  const backTo = `/businesses/${id}/issues${listSearch}`
  const queue = useMemo(() => {
    const query = readIssueQuery(new URLSearchParams(listSearch))
    const list = sortAnswers(filterIssues(all.data?.issues ?? [], query), query.sort === "oldest" ? "oldest" : "recent")
    return list.filter((i) => i.state !== "NEEDS_REVIEW")
  }, [all.data, listSearch])
  const position = queue.findIndex((i) => i.claim_id === claimId)
  const prev = position > 0 ? queue[position - 1] : null
  const next = position >= 0 && position < queue.length - 1 ? queue[position + 1] : null
  const sameClaim = useMemo(() => {
    if (!issue) return []
    const k = issue.claim_text.trim().toLowerCase()
    return sortAnswers(
      (all.data?.issues ?? []).filter((i) => i.claim_id !== claimId && i.claim_text.trim().toLowerCase() === k),
      "recent",
    )
  }, [all.data, issue, claimId])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Skeleton className="h-80 rounded-xl" />
          <Skeleton className="h-96 rounded-xl" />
        </div>
      </div>
    )
  }
  if (error || !issue) {
    return (
      <EmptyState
        icon={<TriangleAlertIcon />}
        title="Issue not found"
        description="It may have been resolved, removed, or belong to a different account."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to={backTo}>Back to issues</Link>
          </Button>
        }
      />
    )
  }

  const loop = loopApi.data?.loop ?? null
  const actions: Intervention[] = actionsApi.data?.interventions ?? []
  const reviewHref = `/observations/${issue.observation_id}?claim=${issue.claim_id}`

  return (
    <div className="space-y-4 pb-4">
      <PageHeader
        back={{ to: backTo, label: "Issues" }}
        title={<>&ldquo;{issue.claim_text}&rdquo;</>}
        meta={
          <>
            <IssueStateBadge state={issue.state} />
            <ProviderChip provider={issue.provider} model={issue.observed_model} />
            <span title={formatDateTime(issue.collected_at)}>{relativeTime(issue.collected_at)}</span>
            {issue.question_prompt ? (
              <span className="inline-flex min-w-0 items-center gap-1">
                <MessageSquareQuoteIcon className="size-3.5 shrink-0" />
                Asked <span className="font-medium text-foreground">&ldquo;{issue.question_prompt}&rdquo;</span>
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            {position >= 0 && queue.length > 1 ? (
              <div className="flex items-center gap-1 rounded-lg border bg-background p-0.5 shadow-xs">
                <QueueLink to={prev ? `/businesses/${id}/issues/${prev.claim_id}${listSearch}` : null} label="Previous issue">
                  <ChevronLeftIcon />
                </QueueLink>
                <span className="px-1 text-xs text-muted-foreground tabular-nums">
                  {position + 1} of {queue.length}
                </span>
                <QueueLink to={next ? `/businesses/${id}/issues/${next.claim_id}${listSearch}` : null} label="Next issue">
                  <ChevronRightIcon />
                </QueueLink>
              </div>
            ) : null}
            <EvidencePacketButton businessId={id} claimId={claimId} />
          </>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <ComparisonCard issue={issue} reviewHref={reviewHref} />
          <AnswerCard issue={issue} />
          <SourceEvidenceCard businessId={id} citations={issue.citation_evidence} />
          <BeforeAfterCompare loop={loop} loading={loopApi.loading} />
          <RecordedActionsCard businessId={id} claimId={claimId} actions={actions} loading={actionsApi.loading} reload={reload} />
          {sameClaim.length > 0 ? <SameClaimCard businessId={id} items={sameClaim} search={listSearch} /> : null}
        </div>

        <div className="space-y-4 lg:sticky lg:top-0">
          <IssueLoopSection
            businessId={id}
            claimId={claimId}
            loop={loop}
            loading={loopApi.loading}
            error={loopApi.error}
            reload={reload}
            reviewHref={reviewHref}
            actions={actions}
          />
        </div>
      </div>
    </div>
  )
}

function QueueLink({ to, label, children }: { to: string | null; label: string; children: ReactNode }) {
  if (!to) {
    return (
      <Button variant="ghost" size="icon-sm" className="size-7" disabled aria-label={label}>
        {children}
      </Button>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon-sm" className="size-7">
          <Link to={to} aria-label={label}>
            {children}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/* ---------------------------------------------------------- Comparison */

function ComparisonCard({ issue, reviewHref }: { issue: IssueDetail; reviewHref: string }) {
  const reviewed = issue.verdict !== null
  return (
    <Card className="gap-0 py-0">
      <PanelHeader title="AI said vs Approved truth" description="The transcribed claim beside what the business stands behind" />
      <div className="grid md:grid-cols-2">
        <div className="relative border-b p-4 md:border-r md:border-b-0">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <MessageSquareQuoteIcon className="size-3.5" />
            AI said
          </div>
          <p className="text-xs leading-relaxed font-medium">{issue.claim_text}</p>
        </div>
        <div className="relative p-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <BookCheckIcon className="size-3.5" />
            Approved truth
          </div>
          {issue.facts.length > 0 ? (
            <dl className="space-y-2">
              {issue.facts.map((f) => (
                <div key={f.id}>
                  <dt className="text-xs text-muted-foreground">{sentenceCase(f.predicate)}</dt>
                  <dd className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-xs font-semibold">{f.valueText}</span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">v{f.version}</span>
                    {f.status !== "ACTIVE" ? <Badge variant="secondary">{sentenceCase(f.status)}</Badge> : null}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              {reviewed ? "No approved fact was linked to this verdict." : "Not compared yet. Review the claim to link the facts it touches."}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-muted/30 px-4 py-2.5">
        <span className="text-[11px] font-medium text-muted-foreground">Reviewer decision</span>
        <VerdictBadge verdict={issue.verdict} />
        {issue.notes ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">&ldquo;{issue.notes}&rdquo;</span> : <span className="flex-1" />}
        <Button asChild variant={reviewed ? "ghost" : "default"} size="sm">
          <Link to={reviewHref}>
            <PenLineIcon />
            {reviewed ? "Change verdict" : "Review claim"}
          </Link>
        </Button>
      </div>
    </Card>
  )
}

function AnswerCard({ issue }: { issue: IssueDetail }) {
  const [expanded, setExpanded] = useState(false)
  const answer = issue.answer_text
  const needle = issue.claim_text.trim().replace(/[.。]$/, "")
  const at = needle ? answer.toLowerCase().indexOf(needle.toLowerCase()) : -1
  const long = answer.length > 420
  return (
    <Card className="gap-0 py-0">
      <PanelHeader title="Full AI answer" description="Exactly as collected">
        <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
          <Link to={`/observations/${issue.observation_id}`}>
            Open answer
            <ExternalLinkIcon />
          </Link>
        </Button>
      </PanelHeader>
      <div className="px-4 py-3">
        <p className={cn("text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground", long && !expanded && "line-clamp-5")}>
          {at >= 0 ? (
            <>
              {answer.slice(0, at)}
              <mark className="rounded-sm bg-partial-soft px-0.5 text-foreground">{answer.slice(at, at + needle.length)}</mark>
              {answer.slice(at + needle.length)}
            </>
          ) : (
            answer
          )}
        </p>
        {long ? (
          <button type="button" onClick={() => setExpanded((e) => !e)} className="mt-1.5 text-xs font-medium text-foreground hover:underline">
            {expanded ? "Show less" : "Show full answer"}
          </button>
        ) : null}
      </div>
    </Card>
  )
}

function SourceEvidenceCard({ businessId, citations }: { businessId: string; citations: CitationEvidence[] }) {
  return (
    <Card className="gap-0 py-0">
      <PanelHeader title="Source evidence" description="What the AI cited, and what OpenRecord observed there" icon={<LinkIcon />} />
      <div className="p-4">
        {citations.length === 0 ? (
          <p className="text-xs text-muted-foreground">No source citation was returned with this observation.</p>
        ) : (
          <ul className="space-y-3">
            {citations.map((c) => (
              <CitationCard key={c.uri} businessId={businessId} citation={c} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

export function CitationCard({ businessId, citation: c }: { businessId: string; citation: CitationEvidence }) {
  return (
    <li className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <a href={c.uri} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium hover:underline">
          <LinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{domainOf(c.uri)}</span>
        </a>
        {c.tracked ? <ControlBadge control={c.tracked.control} /> : null}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.title ?? c.uri}</span>
      </div>
      {c.tracked ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <MiniStat label="Observed there">{c.tracked.observed_value ?? "Not observed yet"}</MiniStat>
          <MiniStat label="Source state">
            <RepresentationStateBadge state={c.tracked.finding} />
          </MiniStat>
          <MiniStat label="Evidence">
            <Link to={`/businesses/${businessId}/representations/${c.tracked.binding_id}`} className="text-primary hover:underline">
              View tracked representation
            </Link>
          </MiniStat>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Representation <span className="font-medium text-foreground">Not tracked</span> — OpenRecord does not observe this URL, so there is no finding for it.
        </p>
      )}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The AI cited a source{c.tracked ? " that OpenRecord also observed" : ""}. Citation shows the source was referenced; it does not prove the source caused the
        answer.
      </p>
    </li>
  )
}

function MiniStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <div className="mb-1 text-[11px] text-muted-foreground">{label}</div>
      <div className="text-xs font-medium">{children}</div>
    </div>
  )
}

function SameClaimCard({ businessId, items, search }: { businessId: string; items: IssueWithEvidence[]; search: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, 6)
  const models = new Set(items.map((i) => i.provider)).size
  return (
    <Card className="gap-0 py-0">
      <PanelHeader title="Same claim elsewhere" description={`${items.length} other answer${items.length === 1 ? "" : "s"} across ${models} model${models === 1 ? "" : "s"}`} />
      <ul className="divide-y">
        {shown.map((o) => (
          <li key={o.claim_id}>
            <Link
              to={o.state === "NEEDS_REVIEW" ? `/observations/${o.observation_id}?claim=${o.claim_id}` : `/businesses/${businessId}/issues/${o.claim_id}${search}`}
              className="grid items-center gap-3 px-4 py-2 text-xs transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto_5.5rem]"
            >
              <ProviderChip provider={o.provider} model={o.observed_model} />
              <IssueStateBadge state={o.state} />
              <span className="text-right text-muted-foreground tabular-nums">{relativeTime(o.collected_at)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {items.length > shown.length ? (
        <button type="button" onClick={() => setAll(true)} className="border-t px-4 py-2 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground">
          Show all {items.length}
        </button>
      ) : null}
    </Card>
  )
}

/* ----------------------------------------------------- Recorded actions */

const interventionTypes = [
  "SOURCE_UPDATED",
  "SOURCE_PUBLISHED",
  "THIRD_PARTY_CORRECTION_REQUESTED",
  "KNOWLEDGE_BASE_UPDATED",
  "STRUCTURED_DATA_UPDATED",
  "OTHER",
] as const

function RecordedActionsCard({
  businessId,
  claimId,
  actions,
  loading,
  reload,
}: {
  businessId: string
  claimId: string
  actions: Intervention[]
  loading: boolean
  reload: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  return (
    <Card className="gap-0 py-0" id="recorded-actions">
      <PanelHeader title="Recorded actions" description="A hand-kept log; it changes no verdict and no observation">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setOpen(true)}>
          <PlusIcon />
          Record action
        </Button>
      </PanelHeader>
      <div className="p-4">
        {loading ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : actions.length === 0 ? (
          <p className="text-xs text-muted-foreground">No actions recorded for this issue yet.</p>
        ) : (
          <ol className="relative space-y-3 before:absolute before:inset-y-1 before:left-[5px] before:w-px before:bg-border">
            {actions.map((a) => (
              <li key={a.id} className="relative pl-6">
                <span aria-hidden className="absolute top-1.5 left-0 size-[11px] rounded-full border-2 border-card bg-primary ring-1 ring-border" />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{sentenceCase(a.type)}</Badge>
                  <span className="min-w-0 text-xs font-medium break-words">{a.target}</span>
                  {a.supersedesId ? <span className="text-xs text-muted-foreground">superseded — history only</span> : null}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{formatDateTime(a.performedAt)}</p>
                {a.notes ? <p className="mt-1 text-xs">{a.notes}</p> : null}
              </li>
            ))}
          </ol>
        )}
      </div>
      <RecordActionDialog open={open} onOpenChange={setOpen} businessId={businessId} claimId={claimId} reload={reload} />
    </Card>
  )
}

function RecordActionDialog({
  open,
  onOpenChange,
  businessId,
  claimId,
  reload,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  businessId: string
  claimId: string
  reload: () => Promise<void>
}) {
  const [type, setType] = useState<string>("SOURCE_UPDATED")
  const [target, setTarget] = useState("")
  const [notes, setNotes] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record action</DialogTitle>
          <DialogDescription>
            Log what was changed for this issue. Recording an action keeps a log; it changes no verdict and no observation. Recheck the AI afterward to compare.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            setPending(true)
            setError(null)
            Interventions.create(businessId, claimId, { type, target: target.trim(), notes: notes.trim() || null })
              .then(async () => {
                toast.success("Action recorded", { description: "Recheck the AI when the change is live." })
                setTarget("")
                setNotes("")
                onOpenChange(false)
                await reload()
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setPending(false))
          }}
        >
          <div className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]">
            <div className="grid gap-2">
              <Label htmlFor="action-type">Action type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="action-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {interventionTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {sentenceCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="action-target">Target</Label>
              <Input id="action-target" value={target} onChange={(e) => setTarget(e.currentTarget.value)} placeholder="https://example.com/pricing" autoFocus />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="action-notes">Notes</Label>
            <Textarea id="action-notes" rows={3} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} placeholder="Optional. What was done, in one line." />
          </div>
          {error ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle className="font-normal">{error}</AlertTitle>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !target.trim()}>
              {pending ? <Spinner /> : null}
              Record action
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ----------------------------------------------------------- Issue loop */

const sourceChangeCopy: Record<string, string> = {
  SOURCE_NOT_CHECKED: "Source not checked",
  SOURCE_CHANGED: "Source changed",
  SOURCE_UNCHANGED: "Source unchanged",
  SOURCE_OBSERVATION_FAILED: "Source check failed",
  SOURCE_UNKNOWN: "Source change unknown",
}

const sourceAlignmentCopy: Record<string, string> = {
  IN_SYNC: "Current source state: in sync",
  DRIFT: "Current source state: drift",
  UNKNOWN: "Current source state: unknown",
}

const attemptStateCopy: Record<string, string> = {
  QUEUED: "Recheck queued",
  RUNNING: "Recheck in progress",
  FAILED: "Recheck failed",
  COMPLETED: "Recheck observed",
  FINALIZING: "Finalizing recheck",
}

/** Interventions superseded by a correction stay listed (history) but are
 * marked so new rechecks link the current head, not an old row. */
const interventionHeadIds = (list: Array<{ id: string; supersedesId: string | null }>): Set<string> => {
  const superseded = new Set(list.flatMap((a) => (a.supersedesId ? [a.supersedesId] : [])))
  return new Set(list.filter((a) => !superseded.has(a.id)).map((a) => a.id))
}

type StageStatus = "done" | "current" | "todo" | "failed" | "running"
type Stage = { label: string; detail: string; status: StageStatus; action?: ReactNode }

function IssueLoopSection({
  businessId,
  claimId,
  loop,
  loading,
  error,
  reload,
  reviewHref,
  actions,
}: {
  businessId: string
  claimId: string
  loop: IssueLoop | null
  loading: boolean
  error: unknown
  reload: () => Promise<void>
  reviewHref: string
  actions: Intervention[]
}) {
  const [interventionId, setInterventionId] = useState("none")
  const [recheckPending, setRecheckPending] = useState(false)
  const [recheckError, setRecheckError] = useState<string | null>(null)
  const navigate = useNavigate()

  const comparison = loop?.latestComparison ?? null
  const completed = loop?.completedReobservations ?? []
  const attempts = loop?.reobservationAttempts ?? []
  const activeAttempt = attempts.find((a) => a.state === "QUEUED" || a.state === "RUNNING" || a.state === "FINALIZING") ?? null
  const failedAttempts = attempts.filter((a) => a.state === "FAILED")
  const latestAfter = completed.at(-1)?.after ?? null
  const headIds = interventionHeadIds(loop?.interventions ?? actions)
  const source = loop?.sourceVerification ?? null

  const requestRecheck = () => {
    setRecheckPending(true)
    setRecheckError(null)
    Rechecks.create(businessId, claimId, { interventionId: interventionId === "none" ? null : interventionId })
      .then(() => {
        toast.success("Recheck requested", { description: "The new answer will wait for your review before it is compared." })
        void reload()
      })
      .catch((err: unknown) => setRecheckError(errorMessage(err)))
      .finally(() => setRecheckPending(false))
  }

  // Chronological stages: AI observed → reviewed → issue → action →
  // source check → AI recheck → review → outcome.
  const stages: Stage[] = loop
    ? [
        {
          label: "AI observed",
          detail: `${sentenceCase(loop.originalObservation.provider)} on ${formatDateTime(loop.originalObservation.collectedAt)}`,
          status: "done",
        },
        {
          label: "Reviewed",
          detail: loop.originalJudgment ? `Verdict ${verdictLabel(loop.originalJudgment.verdict)}` : "Needs review",
          status: loop.originalJudgment ? "done" : "current",
          ...(loop.originalJudgment
            ? {}
            : {
                action: (
                  <Button size="sm" className="h-7 text-xs" onClick={() => navigate(reviewHref)}>
                    <PenLineIcon />
                    Review claim
                  </Button>
                ),
              }),
        },
        { label: "Issue", detail: sentenceCase(loop.issue.state), status: "done" },
        {
          label: "Action",
          detail:
            loop.interventions.length === 0
              ? "No actions recorded"
              : `${loop.interventions.length} recorded action${loop.interventions.length === 1 ? "" : "s"}`,
          status: loop.interventions.length > 0 ? "done" : loop.originalJudgment ? "current" : "todo",
          ...(loop.interventions.length === 0 && loop.originalJudgment
            ? {
                action: (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => document.getElementById("recorded-actions")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  >
                    <PlusIcon />
                    Record action
                  </Button>
                ),
              }
            : {}),
        },
        {
          label: "Source check",
          detail: `${sourceChangeCopy[loop.sourceVerification.change] ?? loop.sourceVerification.change}. ${
            sourceAlignmentCopy[loop.sourceVerification.alignment] ?? loop.sourceVerification.alignment
          }. ${loop.sourceVerification.detail}`,
          status:
            loop.sourceVerification.change === "SOURCE_OBSERVATION_FAILED"
              ? "failed"
              : loop.sourceVerification.change === "SOURCE_CHANGED" || loop.sourceVerification.change === "SOURCE_UNCHANGED"
                ? "done"
                : loop.interventions.length > 0 && loop.sourceVerification.bindingId
                  ? "current"
                  : "todo",
          action: <VerifySourceButton businessId={businessId} bindingId={loop.sourceVerification.bindingId} onChecked={() => void reload()} />,
        },
        {
          label: "AI recheck",
          detail:
            activeAttempt !== null
              ? (attemptStateCopy[activeAttempt.state] ?? activeAttempt.state)
              : completed.length === 0
                ? failedAttempts.length > 0
                  ? `Recheck failed${failedAttempts.length === 1 && failedAttempts[0]?.failureClass ? ` (${failedAttempts[0].failureClass})` : ""}. A new recheck starts a fresh attempt; failures are never re-observed outcomes.`
                  : "Not rechecked yet"
                : `${completed.length} recheck${completed.length === 1 ? "" : "s"} observed`,
          status: activeAttempt ? "running" : completed.length > 0 ? "done" : failedAttempts.length > 0 ? "failed" : loop.originalJudgment ? "current" : "todo",
        },
        {
          label: "Review",
          detail: latestAfter === null ? "Not rechecked yet" : latestAfter.verdict ? verdictLabel(latestAfter.verdict) : "Needs review",
          status: latestAfter === null ? "todo" : latestAfter.verdict ? "done" : "current",
          ...(latestAfter && !latestAfter.verdict
            ? {
                action: (
                  <Button size="sm" className="h-7 text-xs" onClick={() => navigate(`/observations/${latestAfter.observationId}`)}>
                    <PenLineIcon />
                    Review recheck
                  </Button>
                ),
              }
            : {}),
        },
        {
          label: "Outcome",
          detail: comparison ? `${comparison.displayCopy}. ${comparison.comparabilityExplanation}` : "Not rechecked yet",
          status: comparison ? "done" : "todo",
        },
      ]
    : []

  return (
    <>
      <Card className="gap-0 py-0">
        <PanelHeader title="Issue timeline" description="In the order it happened" />
        <div className="p-4">
          {loading ? (
            <Skeleton className="h-72 rounded-lg" />
          ) : !loop ? (
            <p className="text-xs text-muted-foreground">{error ? "The issue timeline is unavailable right now." : "No timeline for this issue yet."}</p>
          ) : (
            <ol>
              {stages.map((s, idx) => (
                <li key={s.label} className="relative flex gap-3 pb-4 last:pb-0">
                  {idx < stages.length - 1 ? (
                    <span aria-hidden className={cn("absolute top-6 bottom-0 left-[9px] w-px", s.status === "done" ? "bg-supported/40" : "bg-border")} />
                  ) : null}
                  <StageDot status={s.status} />
                  <div className="min-w-0 flex-1 pt-px">
                    <p className={cn("text-xs font-medium", s.status === "todo" && "text-muted-foreground")}>{s.label}</p>
                    <p className="text-xs leading-relaxed text-muted-foreground">{s.detail}</p>
                    {s.action ? <div className="mt-2">{s.action}</div> : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p className="mt-4 border-t pt-3 text-[11px] leading-relaxed text-muted-foreground">New observations never rewrite earlier stages.</p>
        </div>
      </Card>

      <Card className="gap-0 py-0">
        <PanelHeader title="Recheck AI" description="Ask the same question again" icon={<RefreshCwIcon />} />
        <form
          className="grid gap-3 p-4"
          onSubmit={(e) => {
            e.preventDefault()
            requestRecheck()
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="recheck-intervention" className="text-xs">
              Linked action (optional)
            </Label>
            <Select value={interventionId} onValueChange={setInterventionId}>
              <SelectTrigger id="recheck-intervention" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No specific action</SelectItem>
                {(loop?.interventions ?? actions).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {sentenceCase(a.type)} — {a.target}
                    {headIds.has(a.id) ? "" : " (superseded)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {activeAttempt ? (
            <div className="flex items-center gap-2 rounded-md bg-review-soft px-3 py-2 text-xs text-review">
              <LoaderCircleIcon className="size-3.5 animate-spin" />
              {attemptStateCopy[activeAttempt.state] ?? activeAttempt.state}. This page updates on its own.
            </div>
          ) : null}
          {recheckError ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle className="font-normal">{recheckError}</AlertTitle>
            </Alert>
          ) : null}
          <Button type="submit" size="sm" disabled={recheckPending || activeAttempt !== null}>
            {recheckPending ? <Spinner /> : <RefreshCwIcon />}
            {recheckPending ? "Requesting recheck…" : "Recheck AI"}
          </Button>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            A recheck only adds a new observation for review; it changes no verdict and no recorded action. Every rechecked answer waits for a reviewer before it can
            be compared: unreviewed rechecks stay at Needs review.
          </p>
        </form>
      </Card>

      {source && source.bindingId === null ? (
        <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
          <ScanSearchIcon className="mr-1 inline size-3.5 align-[-2px]" />
          Verify source: this action is not linked to a tracked representation, so OpenRecord cannot verify the source automatically.
        </p>
      ) : null}
    </>
  )
}

function StageDot({ status }: { status: StageStatus }) {
  const base = "relative z-10 flex size-[19px] shrink-0 items-center justify-center rounded-full border shadow-(--badge-shadow) [&_svg]:size-3"
  if (status === "done")
    return (
      <span className={cn(base, "border-supported/30 bg-supported-soft text-supported")}>
        <CheckIcon strokeWidth={3} />
      </span>
    )
  if (status === "failed")
    return (
      <span className={cn(base, "border-wrong/30 bg-wrong-soft text-wrong")}>
        <XIcon strokeWidth={3} />
      </span>
    )
  if (status === "running")
    return (
      <span className={cn(base, "border-review/30 bg-review-soft text-review")}>
        <LoaderCircleIcon className="animate-spin" />
      </span>
    )
  if (status === "current")
    return (
      <span className={cn(base, "border-review/40 bg-background text-review")}>
        <span className="size-2 rounded-full bg-review" />
      </span>
    )
  return (
    <span className={cn(base, "border-border bg-background text-muted-foreground/60 shadow-none")}>
      <CircleDashedIcon />
    </span>
  )
}

function VerifySourceButton({ businessId, bindingId, onChecked }: { businessId: string; bindingId: string | null; onChecked: () => void }) {
  const [checking, setChecking] = useState(false)
  if (bindingId === null) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          disabled={checking}
          onClick={() => {
            setChecking(true)
            Sources.check(businessId, bindingId)
              .then((r) => {
                const state = r.finding.state
                toast.success("Source check finished", {
                  description:
                    state === "IN_SYNC"
                      ? "The observed value matches the approved value."
                      : state === "DRIFT"
                        ? "The observed value differs from the approved value."
                        : "The observation could not be compared.",
                })
                onChecked()
              })
              .catch((err: unknown) => toast.error("Source check failed", { description: errorMessage(err) }))
              .finally(() => setChecking(false))
          }}
        >
          {checking ? <Spinner /> : <ScanSearchIcon />}
          {checking ? "Checking source…" : "Verify source"}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        Fetch the linked tracked representation again using the same safe collector. The new observation is preserved; nothing is rewritten.
      </TooltipContent>
    </Tooltip>
  )
}

function BeforeAfterCompare({ loop, loading }: { loop: IssueLoop | null; loading: boolean }) {
  const comparison = loop?.latestComparison ?? null
  const source = loop?.sourceVerification ?? null

  return (
    <Card className="gap-0 py-0">
      <PanelHeader title="Before / after" description="The same question, before and after the recorded action" />
      <div className="space-y-4 p-4">
        {loading ? (
          <Skeleton className="h-32 rounded-lg" />
        ) : !loop || !comparison ? (
          <div className="flex items-center gap-3 rounded-lg border border-dashed px-4 py-5 text-xs text-muted-foreground">
            <RefreshCwIcon className="size-4 shrink-0" />
            {!loop ? "The comparison is unavailable right now." : "Not rechecked yet. Record what you changed, then recheck the AI to produce a before/after pair."}
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{comparison.displayCopy}</Badge>
              <span className="text-[11px] text-muted-foreground">
                {sentenceCase(comparison.matchClassification)} · {sentenceCase(comparison.observedChange)} · {sentenceCase(comparison.outcome)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{comparison.comparabilityExplanation}</p>

            {source && (source.beforeValue !== null || source.afterValue !== null) ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <MiniStat label="Source before">{source.beforeValue ?? "Unknown"}</MiniStat>
                <MiniStat label="Source after">{source.afterValue ?? "Unknown"}</MiniStat>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              {(
                [
                  ["Before", comparison.before],
                  ["After", comparison.after],
                ] as const
              ).map(([label, side]) => (
                <div key={label} className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span className="font-semibold tracking-wide text-foreground uppercase">{label}</span>
                    <span>{formatDateTime(side.collectedAt)}</span>
                  </div>
                  <ProviderChip provider={side.provider} model={side.observedModel} className="text-xs" />
                  <p className="text-xs leading-relaxed whitespace-pre-wrap">{side.answerText}</p>
                  {side.claimText ? <p className="text-xs text-muted-foreground">Claim: {side.claimText}</p> : null}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    Verdict <VerdictBadge verdict={side.verdict} />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Comparison is derived at read time. Causal attribution: unknown. OpenRecord observes what changed; it does not claim why.
            </p>
          </>
        )}
      </div>
    </Card>
  )
}

function EvidencePacketButton({ businessId, claimId }: { businessId: string; claimId: string }) {
  const [pending, setPending] = useState(false)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => {
            setPending(true)
            Packets.get(businessId, claimId)
              .then(({ packet, digest: d }) => {
                const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json" })
                const url = URL.createObjectURL(blob)
                const a = document.createElement("a")
                a.href = url
                a.download = `evidence-${claimId.slice(0, 8)}-${d.slice(0, 12)}.json`
                document.body.appendChild(a)
                a.click()
                a.remove()
                setTimeout(() => URL.revokeObjectURL(url), 1000)
                toast.success("Evidence packet downloaded", { description: `Digest ${d.slice(0, 16)}…` })
              })
              .catch((err: unknown) => toast.error("Could not prepare the packet", { description: errorMessage(err) }))
              .finally(() => setPending(false))
          }}
        >
          {pending ? <Spinner /> : <DownloadIcon />}
          Evidence packet
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        <span className="flex items-start gap-1.5">
          <FileJsonIcon className="mt-0.5 size-3.5 shrink-0" />
          Sealed V1 packet as JSON: digest plus claims, judgments, interventions, and re-observations. The digest lets anyone verify the bytes.
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

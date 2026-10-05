import { useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { ArrowLeftIcon, BookCheckIcon, DownloadIcon, FileJsonIcon, LinkIcon, MessageSquareQuoteIcon, TriangleAlertIcon } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState, PageHeader } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { ControlBadge, IssueStateBadge, RepresentationStateBadge } from "@/components/status"
import { Interventions, Issues, Packets, Rechecks, Sources, type CitationEvidence, type Intervention, type IssueLoop } from "@/lib/api"
import { errorMessage, formatDateTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function IssueDetailPage() {
  const { id = "", claimId = "" } = useParams()
  const { data, loading, error } = useApi(`issue:${claimId}`, () => Issues.get(id, claimId))
  const issue = data ?? null

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }
  if (error || !issue) {
    return <EmptyState icon={<TriangleAlertIcon />} title="Issue not found" description="It may have been resolved, removed, or belong to a different account." />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Issue"
        description="One AI claim, the approved truth beside it, and the source evidence around it."
        actions={
          <Button asChild variant="outline">
            <Link to={`/businesses/${id}/issues`}>
              <ArrowLeftIcon />
              All issues
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <IssueStateBadge state={issue.state} />
        <span className="text-sm text-muted-foreground">
          Seen on <span className="font-medium text-foreground">{sentenceCase(issue.provider)}</span>
          {issue.observed_model ? <span> ({issue.observed_model})</span> : null}
          <span> on {formatDateTime(issue.collected_at)}</span>
        </span>
      </div>

      {issue.question_prompt ? (
        <p className="text-sm text-muted-foreground">
          Asked <span className="font-medium text-foreground">&ldquo;{issue.question_prompt}&rdquo;</span>
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-(--float-shadow)">
          <CardHeader>
            <CardTitle>AI said</CardTitle>
            <CardDescription>The exact transcribed claim.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-[15px] leading-relaxed">{issue.claim_text}</p>
            <Button asChild variant="outline" size="sm">
              <Link to={`/observations/${issue.observation_id}`}>View full AI answer</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="shadow-(--float-shadow)">
          <CardHeader>
            <CardTitle>Approved truth</CardTitle>
            <CardDescription>What the business stands behind.</CardDescription>
          </CardHeader>
          <CardContent>
            {issue.facts.length > 0 ? (
              <dl className="space-y-2">
                {issue.facts.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-baseline gap-x-2">
                    <dt className="text-sm text-muted-foreground">{sentenceCase(f.predicate)}</dt>
                    <dd className="text-[15px] font-medium">{f.valueText}</dd>
                    <dd className="text-xs text-muted-foreground tabular-nums">v{f.version}</dd>
                    <dd className="text-xs text-muted-foreground">{f.status}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No approved fact was linked to this verdict.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Source evidence</CardTitle>
          <CardDescription>What the AI cited, and what Ghostping observed there.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {issue.citation_evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">No source citation was returned with this observation.</p>
          ) : (
            <ul className="space-y-3">
              {issue.citation_evidence.map((c) => (
                <CitationCard key={c.uri} businessId={id} citation={c} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Reviewer decision</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {issue.verdict ? (
            <>
              <p className="text-sm">
                Verdict <span className="font-medium">{sentenceCase(issue.verdict)}</span>
              </p>
              {issue.notes ? <p className="text-sm text-muted-foreground">{issue.notes}</p> : null}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground">No reviewer has judged this claim yet.</p>
              <Button asChild size="sm">
                <Link to={`/observations/${issue.observation_id}`}>Review claim</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <RecordedActionsCard businessId={id} claimId={claimId} />

      <IssueLoopSection businessId={id} claimId={claimId} />

      <BeforeAfterCompare businessId={id} claimId={claimId} />

      <EvidencePacketCard businessId={id} claimId={claimId} />
    </div>
  )
}

const interventionTypes = [
  "SOURCE_UPDATED",
  "SOURCE_PUBLISHED",
  "THIRD_PARTY_CORRECTION_REQUESTED",
  "KNOWLEDGE_BASE_UPDATED",
  "STRUCTURED_DATA_UPDATED",
  "OTHER",
] as const

function RecordedActionsCard({ businessId, claimId }: { businessId: string; claimId: string }) {
  const { data, loading, reload } = useApi(`interventions:${claimId}`, () => Interventions.list(businessId, claimId))
  const [type, setType] = useState<string>("SOURCE_UPDATED")
  const [target, setTarget] = useState("")
  const [notes, setNotes] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actions: Intervention[] = data?.interventions ?? []

  return (
    <Card className="shadow-(--float-shadow)">
      <CardHeader>
        <CardTitle>Recorded actions</CardTitle>
        <CardDescription>
          Actions taken for this issue, recorded by hand. Recording an action keeps a log; it changes no verdict and no observation.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Skeleton className="h-20 rounded-lg" />
        ) : actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No actions recorded for this issue yet.</p>
        ) : (
          <ul className="space-y-3">
            {actions.map((a) => (
              <li key={a.id} className="space-y-1 rounded-lg border px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{sentenceCase(a.type)}</Badge>
                  <span className="text-sm font-medium break-words">{a.target}</span>
                  {a.supersedesId ? (
                    <span className="text-xs text-muted-foreground">superseded — history only</span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{formatDateTime(a.performedAt)}</p>
                {a.notes ? <p className="text-sm">{a.notes}</p> : null}
              </li>
            ))}
          </ul>
        )}

        <form
          className="grid gap-4 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault()
            setPending(true)
            setError(null)
            Interventions.create(businessId, claimId, { type, target: target.trim(), notes: notes.trim() || null })
              .then(() => {
                toast.success("Action recorded")
                setTarget("")
                setNotes("")
                void reload()
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setPending(false))
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="action-type">Action type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="action-type">
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
              <Input
                id="action-target"
                value={target}
                onChange={(e) => setTarget(e.currentTarget.value)}
                placeholder="https://example.com/pricing"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="action-notes">Notes</Label>
            <Textarea
              id="action-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.currentTarget.value)}
              placeholder="Optional. What was done, in one line."
            />
          </div>
          {error ? (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle className="font-normal">{error}</AlertTitle>
            </Alert>
          ) : null}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={pending || !target.trim()}>
              {pending ? <Spinner /> : null}
              Record action
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

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

function IssueLoopSection({ businessId, claimId }: { businessId: string; claimId: string }) {
  const { data, loading, error, reload } = useApi(`loop:${claimId}`, () => Rechecks.getLoop(businessId, claimId))
  const loop: IssueLoop | null = data?.loop ?? null
  const [interventionId, setInterventionId] = useState("none")
  const [recheckPending, setRecheckPending] = useState(false)
  const [recheckError, setRecheckError] = useState<string | null>(null)

  const comparison = loop?.latestComparison ?? null
  const completed = loop?.completedReobservations ?? []
  const attempts = loop?.reobservationAttempts ?? []
  const activeAttempt = attempts.find((a) => a.state === "QUEUED" || a.state === "RUNNING" || a.state === "FINALIZING") ?? null
  const failedAttempts = attempts.filter((a) => a.state === "FAILED")
  const latestAfter = completed.at(-1)?.after ?? null
  const headIds = interventionHeadIds(loop?.interventions ?? [])

  // Chronological stages: AI observed → reviewed → issue → action →
  // source check → AI recheck → review → outcome.
  const stages: Array<{ label: string; detail: string }> = loop
    ? [
        {
          label: "AI observed",
          detail: `${sentenceCase(loop.originalObservation.provider)} on ${formatDateTime(loop.originalObservation.collectedAt)}`,
        },
        {
          label: "Reviewed",
          detail: loop.originalJudgment ? `Verdict ${sentenceCase(loop.originalJudgment.verdict)}` : "Needs review",
        },
        { label: "Issue", detail: sentenceCase(loop.issue.state) },
        {
          label: "Action",
          detail:
            loop.interventions.length === 0
              ? "No actions recorded"
              : `${loop.interventions.length} recorded action${loop.interventions.length === 1 ? "" : "s"}`,
        },
        {
          label: "Source check",
          detail: `${sourceChangeCopy[loop.sourceVerification.change] ?? loop.sourceVerification.change}. ${
            sourceAlignmentCopy[loop.sourceVerification.alignment] ?? loop.sourceVerification.alignment
          }. ${loop.sourceVerification.detail}`,
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
        },
        {
          label: "Review",
          detail:
            latestAfter === null ? "Not rechecked yet" : latestAfter.verdict ? sentenceCase(latestAfter.verdict) : "Needs review",
        },
        {
          label: "Outcome",
          detail: comparison ? `${comparison.displayCopy}. ${comparison.comparabilityExplanation}` : "Not rechecked yet",
        },
      ]
    : []

  return (
    <>
      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Issue timeline</CardTitle>
          <CardDescription>Each stage in the order it happened. New observations never rewrite earlier stages.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-40 rounded-lg" />
          ) : !loop ? (
            <p className="text-sm text-muted-foreground">
              {error ? "The issue timeline is unavailable right now." : "No timeline for this issue yet."}
            </p>
          ) : (
            <ol className="space-y-4">
              {stages.map((s) => (
                <li key={s.label} className="flex gap-3">
                  <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{s.label}</p>
                    <p className="text-sm text-muted-foreground">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Recheck AI</CardTitle>
          <CardDescription>
            Ask for a fresh AI observation of the same question. A recheck only adds a new observation for review; it changes
            no verdict and no recorded action.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              setRecheckPending(true)
              setRecheckError(null)
              Rechecks.create(businessId, claimId, { interventionId: interventionId === "none" ? null : interventionId })
                .then(() => {
                  toast.success("Recheck requested")
                  void reload()
                })
                .catch((err: unknown) => setRecheckError(errorMessage(err)))
                .finally(() => setRecheckPending(false))
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="recheck-intervention">Linked action (optional)</Label>
              <Select value={interventionId} onValueChange={setInterventionId}>
                <SelectTrigger id="recheck-intervention">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific action</SelectItem>
                  {(loop?.interventions ?? []).map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {sentenceCase(a.type)} — {a.target}
                      {headIds.has(a.id) ? "" : " (superseded)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {recheckError ? (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle className="font-normal">{recheckError}</AlertTitle>
              </Alert>
            ) : null}
            <div className="flex items-center justify-end gap-3">
              {recheckPending ? <p className="text-sm text-muted-foreground">Requesting recheck…</p> : null}
              <Button type="submit" size="sm" disabled={recheckPending}>
                {recheckPending ? <Spinner /> : null}
                Recheck AI
              </Button>
            </div>
          </form>
          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            Every rechecked answer waits for a reviewer before it can be compared: unreviewed rechecks stay at Needs review.
          </p>
        </CardContent>
      </Card>

      <VerifySourceCard
        businessId={businessId}
        bindingId={loop?.sourceVerification.bindingId ?? null}
        onChecked={() => void reload()}
      />
    </>
  )
}

function VerifySourceCard({ businessId, bindingId, onChecked }: { businessId: string; bindingId: string | null; onChecked: () => void }) {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [checkError, setCheckError] = useState<string | null>(null)
  if (bindingId === null) {
    return (
      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Verify source</CardTitle>
          <CardDescription>
            This action is not linked to a tracked representation, so Ghostping cannot verify the source automatically.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <Card className="shadow-(--float-shadow)">
      <CardHeader>
        <CardTitle>Verify source</CardTitle>
        <CardDescription>
          Fetch the linked tracked representation again using the same safe collector. The new observation is preserved;
          nothing is rewritten.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {result ? <p className="text-sm text-muted-foreground">{result}</p> : null}
        {checkError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle className="font-normal">{checkError}</AlertTitle>
          </Alert>
        ) : null}
        <div className="flex items-center justify-end gap-3">
          {checking ? <p className="text-sm text-muted-foreground">Checking source…</p> : null}
          <Button
            size="sm"
            disabled={checking}
            onClick={() => {
              setChecking(true)
              setCheckError(null)
              setResult(null)
              Sources.check(businessId, bindingId)
                .then((r) => {
                  const state = r.finding.state
                  setResult(
                    state === "IN_SYNC"
                      ? "Source check finished: the observed value matches the approved value."
                      : state === "DRIFT"
                        ? "Source check finished: the observed value differs from the approved value."
                        : "Source check finished: the observation could not be compared.",
                  )
                  onChecked()
                })
                .catch((err: unknown) => setCheckError(errorMessage(err)))
                .finally(() => setChecking(false))
            }}
          >
            {checking ? <Spinner /> : null}
            Verify source
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function BeforeAfterCompare({ businessId, claimId }: { businessId: string; claimId: string }) {
  const { data, loading } = useApi(`loop-compare:${claimId}`, () => Rechecks.getLoop(businessId, claimId))
  const loop: IssueLoop | null = data?.loop ?? null
  const comparison = loop?.latestComparison ?? null
  const source = loop?.sourceVerification ?? null

  return (
    <Card className="shadow-(--float-shadow)">
      <CardHeader>
        <CardTitle>Before / after</CardTitle>
        <CardDescription>
          The same question, observed before and after the recorded action. Comparison is derived at read time; it never claims the action caused the change.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Skeleton className="h-40 rounded-lg" />
        ) : !loop || !comparison ? (
          <p className="text-sm text-muted-foreground">
            {!loop ? "The comparison is unavailable right now." : "Not rechecked yet. Request a recheck above to produce a before/after pair."}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{comparison.displayCopy}</Badge>
              <span className="text-xs text-muted-foreground">
                {comparison.matchClassification} · {comparison.observedChange} · {comparison.outcome}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">{comparison.comparabilityExplanation}</p>
            <p className="text-xs text-muted-foreground">Causal attribution: unknown. Ghostping observes what changed; it does not claim why.</p>

            {source && (source.beforeValue !== null || source.afterValue !== null) ? (
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-lg bg-muted/60 p-3">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Source before</div>
                  <p className="text-sm font-medium">{source.beforeValue ?? "Unknown"}</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-3">
                  <div className="mb-1 text-xs font-medium text-muted-foreground">Source after</div>
                  <p className="text-sm font-medium">{source.afterValue ?? "Unknown"}</p>
                </div>
              </div>
            ) : null}

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2 rounded-lg border p-3">
                <div className="text-xs font-medium text-muted-foreground">
                  Before · {sentenceCase(comparison.before.provider)}
                  {comparison.before.observedModel ? ` (${comparison.before.observedModel})` : ""} · {formatDateTime(comparison.before.collectedAt)}
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{comparison.before.answerText}</p>
                {comparison.before.claimText ? <p className="text-xs text-muted-foreground">Claim: {comparison.before.claimText}</p> : null}
                <p className="text-xs text-muted-foreground">Verdict: {comparison.before.verdict ? sentenceCase(comparison.before.verdict) : "Needs review"}</p>
              </div>
              <div className="space-y-2 rounded-lg border p-3">
                <div className="text-xs font-medium text-muted-foreground">
                  After · {sentenceCase(comparison.after.provider)}
                  {comparison.after.observedModel ? ` (${comparison.after.observedModel})` : ""} · {formatDateTime(comparison.after.collectedAt)}
                </div>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{comparison.after.answerText}</p>
                {comparison.after.claimText ? <p className="text-xs text-muted-foreground">Claim: {comparison.after.claimText}</p> : null}
                <p className="text-xs text-muted-foreground">Verdict: {comparison.after.verdict ? sentenceCase(comparison.after.verdict) : "Needs review"}</p>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function EvidencePacketCard({ businessId, claimId }: { businessId: string; claimId: string }) {
  const [pending, setPending] = useState(false)
  const [digest, setDigest] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <Card className="shadow-(--float-shadow)">
      <CardHeader>
        <CardTitle>Evidence packet</CardTitle>
        <CardDescription>Download the sealed lineage for this issue as JSON. The digest lets anyone verify the bytes.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        {digest ? <p className="text-xs break-all text-muted-foreground">Digest: {digest}</p> : null}
        {error ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle className="font-normal">{error}</AlertTitle>
          </Alert>
        ) : null}
        <div className="flex items-center justify-end gap-3">
          {pending ? <p className="text-sm text-muted-foreground">Preparing packet…</p> : null}
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => {
              setPending(true)
              setError(null)
              Packets.get(businessId, claimId)
                .then(({ packet, digest: d }) => {
                  setDigest(d)
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
                .catch((err: unknown) => setError(errorMessage(err)))
                .finally(() => setPending(false))
            }}
          >
            {pending ? <Spinner /> : <DownloadIcon />}
            Download packet (JSON)
          </Button>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <FileJsonIcon className="size-3.5" />
          Sealed V1 packet: digest plus claims, judgments, interventions, and re-observations.
        </p>
      </CardContent>
    </Card>
  )
}

export function CitationCard({ businessId, citation: c }: { businessId: string; citation: CitationEvidence }) {
  return (
    <li className="space-y-3 rounded-lg border px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <LinkIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{domainOf(c.uri)}</span>
        {c.tracked ? <ControlBadge control={c.tracked.control} /> : null}
      </div>
      {c.tracked ? (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg bg-muted/60 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Observed there</div>
            <p className="text-sm font-medium">{c.tracked.observed_value ?? "Not observed yet"}</p>
          </div>
          <div className="rounded-lg bg-muted/60 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Source state</div>
            <RepresentationStateBadge state={c.tracked.finding} />
          </div>
          <div className="rounded-lg bg-muted/60 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Evidence</div>
            <Button asChild variant="link" size="sm" className="h-auto p-0">
              <Link to={`/businesses/${businessId}/representations/${c.tracked.binding_id}`}>View tracked representation</Link>
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Representation <span className="font-medium text-foreground">Not tracked</span> — Ghostping does not observe this URL, so there is no
          finding for it.
        </p>
      )}
      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <BookCheckIcon className="mt-0.5 size-3.5 shrink-0" />
        The AI cited a source{c.tracked ? " that Ghostping also observed" : ""}. Citation shows the source was referenced; it does not prove the
        source caused the answer.
      </p>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquareQuoteIcon className="size-3.5" />
        {c.title ?? c.uri}
      </p>
    </li>
  )
}

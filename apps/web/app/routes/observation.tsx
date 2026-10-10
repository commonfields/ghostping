import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router"
import { toast } from "sonner"
import { ArrowRightIcon, BookCheckIcon, CheckIcon, ChevronDownIcon, FileSearchIcon, LinkIcon, PlusIcon, QuoteIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState, Field, PageHeader, Panel, PanelHeader, domainOf } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { IssueStateBadge, ProviderChip, VerdictBadge } from "@/components/status"
import { Claims, Facts, Issues, Judgments, Observations, Representations, type Fact, type IssueState } from "@/lib/api"
import { sortAnswers } from "@/lib/issues"
import { errorMessage, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

const verdicts = [
  { value: "SUPPORTED", label: "Supported", hint: "Matches your approved facts", tone: "supported" },
  { value: "CONTRADICTED", label: "Wrong", hint: "Disagrees with an approved fact", tone: "wrong" },
  { value: "PARTIAL", label: "Partially correct", hint: "Some of it is right, some is not", tone: "partial" },
  { value: "INSUFFICIENT_EVIDENCE", label: "Not enough information", hint: "No approved fact covers it", tone: "unknown" },
] as const

const toneRing: Record<(typeof verdicts)[number]["tone"], string> = {
  supported: "border-supported/50 bg-supported-soft/70",
  wrong: "border-wrong/50 bg-wrong-soft/70",
  partial: "border-partial/50 bg-partial-soft/70",
  unknown: "border-unknown/50 bg-unknown-soft/70",
}
const toneDot: Record<(typeof verdicts)[number]["tone"], string> = {
  supported: "bg-supported",
  wrong: "bg-wrong",
  partial: "bg-partial",
  unknown: "bg-unknown",
}

export function ObservationPage() {
  const { observationId = "" } = useParams()
  const [params] = useSearchParams()
  const focusClaim = params.get("claim")
  const nav = useNavigate()
  const { setActiveBusinessId, reloadOverview } = useWorkspace()
  const obs = useApi(`obs:${observationId}`, () => Observations.get(observationId))
  const observation = obs.data?.observation ?? null
  const businessId = observation?.business_id ?? null

  useEffect(() => {
    if (businessId) setActiveBusinessId(businessId)
  }, [businessId, setActiveBusinessId])

  const facts = useApi(businessId ? `facts:${businessId}` : null, () => Facts.list(businessId ?? ""))
  const issues = useApi(businessId ? `issues:${businessId}` : null, () => Issues.list(businessId ?? ""))
  const representations = useApi(businessId ? `representations:${businessId}` : null, () => Representations.list(businessId ?? ""))
  const trackedRows = useMemo(() => representations.data?.representations ?? [], [representations.data])
  const activeFacts = useMemo(() => (facts.data?.facts ?? []).filter((f) => f.status === "ACTIVE"), [facts.data])
  const stateByClaim = useMemo(() => new Map((issues.data?.issues ?? []).map((i) => [i.claim_id, i.state])), [issues.data])
  const verdictByClaim = useMemo(() => new Map((issues.data?.issues ?? []).map((i) => [i.claim_id, i.verdict])), [issues.data])

  // The review queue: unreviewed claims anywhere in this business, newest first.
  const queue = useMemo(() => sortAnswers((issues.data?.issues ?? []).filter((i) => i.state === "NEEDS_REVIEW"), "recent"), [issues.data])
  const nextElsewhere = queue.find((i) => i.observation_id !== observationId) ?? null

  const [claimText, setClaimText] = useState("")
  const [savingClaim, setSavingClaim] = useState(false)
  const [justRecorded, setJustRecorded] = useState(false)

  if (obs.loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-14 w-72" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-32 rounded-xl" />
      </div>
    )
  }

  if (!observation) {
    return (
      <EmptyState
        icon={<FileSearchIcon />}
        title="Answer not found"
        description="It may belong to another account, or the link is incomplete."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/businesses">See all businesses</Link>
          </Button>
        }
      />
    )
  }

  const claims = obs.data?.claims ?? []
  const citations = obs.data?.citations ?? []
  const pendingHere = claims.filter((c) => stateByClaim.get(c.id) === "NEEDS_REVIEW")
  const fromIssues = focusClaim !== null

  return (
    <div className="space-y-4 pb-4">
      <PageHeader
        back={fromIssues ? { to: `/businesses/${observation.business_id}/issues`, label: "Issues" } : { to: `/businesses/${observation.business_id}/checks`, label: "Checks" }}
        title="AI answer"
        description="The answer exactly as collected. Copy each factual statement you want to verify into a claim, then judge it against your approved facts."
        meta={
          <>
            <ProviderChip provider={observation.provider} model={observation.observed_model} />
            <span title={formatDateTime(observation.collected_at)}>{relativeTime(observation.collected_at)}</span>
            {queue.length > 0 ? (
              <span className="rounded-full bg-review-soft px-2 py-0.5 text-[11px] font-medium text-review shadow-(--badge-shadow)">
                {queue.length} answer{queue.length === 1 ? "" : "s"} in the review queue
              </span>
            ) : null}
          </>
        }
        actions={
          nextElsewhere ? (
            <Button asChild variant="outline" size="sm">
              <Link to={`/observations/${nextElsewhere.observation_id}?claim=${nextElsewhere.claim_id}`}>
                {pendingHere.length ? "Skip to next answer" : "Next answer to review"}
                <ArrowRightIcon />
              </Link>
            </Button>
          ) : null
        }
      />

      {justRecorded && pendingHere.length === 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-supported/25 bg-supported-soft/60 px-4 py-2.5 shadow-(--card-shadow)">
          <CheckIcon className="size-4 text-supported" />
          <p className="min-w-0 flex-1 text-xs">
            <span className="font-medium">Every claim in this answer has a verdict.</span>{" "}
            <span className="text-muted-foreground">
              {nextElsewhere ? `${queue.length} answer${queue.length === 1 ? "" : "s"} still wait in the queue.` : "The review queue is empty."}
            </span>
          </p>
          {nextElsewhere ? (
            <Button asChild size="sm" className="h-7 text-xs">
              <Link to={`/observations/${nextElsewhere.observation_id}?claim=${nextElsewhere.claim_id}`}>
                Next answer
                <ArrowRightIcon />
              </Link>
            </Button>
          ) : (
            <Button asChild size="sm" variant="outline" className="h-7 text-xs">
              <Link to={`/businesses/${observation.business_id}/issues`}>Back to issues</Link>
            </Button>
          )}
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          <Panel>
            <div className="space-y-3 p-5">
              <QuoteIcon className="size-5 text-muted-foreground/50" />
              <p className="text-xs leading-relaxed whitespace-pre-wrap">{observation.answer_text}</p>
              {observation.raw_text ? (
                <Collapsible>
                  <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-md pt-2 text-xs text-muted-foreground outline-none hover:text-foreground">
                    <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
                    Raw provider response
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">{observation.raw_text}</pre>
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              title="Claims"
              description={
                claims.length
                  ? `${claims.length} transcribed · ${pendingHere.length ? `${pendingHere.length} waiting for a verdict` : "all reviewed"}`
                  : "Transcribe one statement at a time, in the AI's words"
              }
            />
            <div className="space-y-3 p-4 pt-3">
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-start"
                onSubmit={(e) => {
                  e.preventDefault()
                  setSavingClaim(true)
                  Claims.create(observationId, claimText)
                    .then(() => {
                      setClaimText("")
                      toast.success("Claim saved", { description: "Record a verdict for it below." })
                      reloadOverview()
                      return Promise.all([obs.reload(), issues.reload()])
                    })
                    .catch((err: unknown) => toast.error("Could not save the claim", { description: errorMessage(err) }))
                    .finally(() => setSavingClaim(false))
                }}
              >
                <Label htmlFor="claim-text" className="sr-only">
                  Claim
                </Label>
                <Textarea
                  id="claim-text"
                  rows={1}
                  className="min-h-8 flex-1"
                  value={claimText}
                  onChange={(e) => setClaimText(e.currentTarget.value)}
                  placeholder="Add a claim, e.g. “Northstar costs $29 per month.”"
                />
                <Button type="submit" size="sm" className="h-8" disabled={savingClaim || !claimText.trim()}>
                  {savingClaim ? <Spinner /> : <PlusIcon />}
                  Save claim
                </Button>
              </form>

              {claims.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">No claims transcribed from this answer yet.</p>
              ) : (
                <ul className="space-y-3">
                  {claims.map((c) => (
                    <li key={c.id}>
                      <ClaimReview
                        claimId={c.id}
                        text={c.text}
                        state={stateByClaim.get(c.id) ?? (issues.data ? "RESOLVED" : null)}
                        verdict={verdictByClaim.get(c.id) ?? (issues.data && !stateByClaim.has(c.id) ? "SUPPORTED" : null)}
                        focused={c.id === focusClaim}
                        facts={activeFacts}
                        businessId={observation.business_id}
                        onRecorded={() => {
                          setJustRecorded(true)
                          reloadOverview()
                          void issues.reload()
                        }}
                        onOpenIssue={() => nav(`/businesses/${observation.business_id}/issues/${c.id}`)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>

        <div className="space-y-4 lg:sticky lg:top-0">
          <Panel>
            <PanelHeader title="Answer details" />
            <dl className="grid gap-3 p-4 pt-3">
              <Field label="Provider">{observation.provider === "9router" ? "9Router" : sentenceCase(observation.provider)}</Field>
              <Field label="Model">{observation.observed_model ?? "Not reported"}</Field>
              {observation.requested_model ? <Field label="Requested model">{observation.requested_model}</Field> : null}
              <Field label="Collected">{formatDateTime(observation.collected_at)}</Field>
              <Field label="Retrieval">{sentenceCase(observation.retrieval_mode ?? "unknown")}</Field>
            </dl>
          </Panel>
          <Panel>
            <PanelHeader title="Cited sources" description="As returned by the provider" icon={<LinkIcon />} />
            <div className="p-2 pt-1">
              {citations.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground">No source citation was returned with this observation.</p>
              ) : (
                <ul>
                  {citations.map((c, i) => (
                    <CitationRow key={`${c.uri ?? "null"}-${i}`} citation={c} businessId={observation.business_id} representations={trackedRows} />
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}

function CitationRow({
  citation,
  businessId,
  representations,
}: {
  citation: { uri: string | null; title: string | null; position: number | null; attributed: boolean }
  businessId: string
  representations: Array<{ binding_id: string; source: { url: string } }>
}) {
  const match =
    citation.uri === null
      ? null
      : (representations.find((r) => {
          try {
            const a = new URL(citation.uri as string)
            const b = new URL(r.source.url)
            return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "") && a.search === b.search
          } catch {
            return false
          }
        }) ?? null)
  return (
    <li className="rounded-md px-2 py-2 transition-colors hover:bg-muted/40">
      {citation.uri ? (
        <a href={citation.uri} target="_blank" rel="noreferrer" className="block truncate text-xs font-medium hover:underline">
          {citation.title ?? domainOf(citation.uri)}
        </a>
      ) : (
        <p className="truncate text-xs font-medium">{citation.title ?? "Untitled source"}</p>
      )}
      <p className="truncate text-[11px] text-muted-foreground">
        {citation.uri ? domainOf(citation.uri) : "No URI"}
        {citation.position !== null && citation.position !== undefined ? <span> · position {citation.position}</span> : null}
        {citation.attributed ? <span> · attributed</span> : null}
      </p>
      {match ? (
        <Link to={`/businesses/${businessId}/representations/${match.binding_id}`} className="mt-0.5 inline-block text-[11px] font-medium text-primary hover:underline">
          View tracked representation
        </Link>
      ) : null}
    </li>
  )
}

function ClaimReview({
  claimId,
  text,
  state,
  verdict: currentVerdict,
  focused,
  facts,
  businessId,
  onRecorded,
  onOpenIssue,
}: {
  claimId: string
  text: string
  state: IssueState | "RESOLVED" | null
  verdict: string | null
  focused: boolean
  facts: Fact[]
  businessId: string
  onRecorded: () => void
  onOpenIssue: () => void
}) {
  const [verdict, setVerdict] = useState<string | null>(null)
  const [notes, setNotes] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(state === "NEEDS_REVIEW" || focused)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (state === "NEEDS_REVIEW") setOpen(true)
  }, [state])

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" })
  }, [focused])

  const submit = () => {
    if (!verdict) return
    setPending(true)
    Judgments.create(claimId, verdict, selected, notes || undefined)
      .then(() => {
        toast.success("Verdict recorded", {
          description: verdict === "SUPPORTED" ? "Supported claims stay out of the issues inbox." : "It now shows in the issues inbox.",
        })
        setOpen(false)
        setNotes("")
        setVerdict(null)
        onRecorded()
      })
      .catch((err: unknown) => toast.error("Could not record the verdict", { description: errorMessage(err) }))
      .finally(() => setPending(false))
  }

  return (
    <div
      ref={ref}
      className={cn(
        "overflow-hidden rounded-lg border bg-card transition-shadow",
        focused && open && "border-review/40 shadow-[0_0_0_3px_var(--review-soft)]",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <p className="min-w-0 flex-1 text-xs leading-relaxed font-medium">{text}</p>
        <div className="flex items-center gap-2">
          {state === "RESOLVED" || currentVerdict === "SUPPORTED" ? (
            <VerdictBadge verdict="SUPPORTED" />
          ) : state ? (
            <IssueStateBadge state={state} />
          ) : null}
          {state && state !== "NEEDS_REVIEW" && !open ? (
            <>
              {state !== "RESOLVED" ? (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onOpenIssue}>
                  View issue
                </Button>
              ) : null}
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setOpen(true)}>
                Change verdict
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {open ? (
        <form
          className="border-t"
          onKeyDown={(e) => {
            const target = e.target as HTMLElement
            if (target.tagName === "TEXTAREA") return
            const idx = Number(e.key) - 1
            if (idx >= 0 && idx < verdicts.length) {
              e.preventDefault()
              setVerdict(verdicts[idx]!.value)
            }
          }}
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div className="space-y-4 px-4 py-4">
            <div className="grid content-start gap-2">
              <span className="text-xs font-medium">Verdict</span>
              <div role="radiogroup" aria-label="Verdict" className="grid gap-1.5 sm:grid-cols-2">
                {verdicts.map((v, i) => {
                  const on = verdict === v.value
                  return (
                    <button
                      key={v.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setVerdict(v.value)}
                      className={cn(
                        "flex items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors outline-none hover:bg-muted/50",
                        on && toneRing[v.tone],
                      )}
                    >
                      <span className={cn("size-2 shrink-0 rounded-full", toneDot[v.tone])} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium">{v.label}</span>
                        <span className="block text-[11px] text-muted-foreground">{v.hint}</span>
                      </span>
                      <Kbd>{i + 1}</Kbd>
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
            <div className="grid content-start gap-2">
              <span className="text-xs font-medium">Approved facts this claim touches</span>
              {facts.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                  <BookCheckIcon className="size-4" />
                  <span>
                    No active facts.{" "}
                    <Link to={`/businesses/${businessId}/truth`} className="font-medium text-foreground underline-offset-4 hover:underline">
                      Add one
                    </Link>
                  </span>
                </div>
              ) : (
                <div className="max-h-48 divide-y overflow-y-auto rounded-lg border">
                  {facts.map((f) => (
                    <Label key={f.id} htmlFor={`${claimId}-${f.id}`} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-xs font-normal hover:bg-muted/50">
                      <Checkbox
                        id={`${claimId}-${f.id}`}
                        checked={selected.includes(f.id)}
                        onCheckedChange={(checked) => setSelected(checked === true ? [...selected, f.id] : selected.filter((s) => s !== f.id))}
                      />
                      <span className="min-w-0 flex-1 text-muted-foreground">{sentenceCase(f.predicate)}</span>
                      <span className="font-medium">{f.valueText}</span>
                    </Label>
                  ))}
                </div>
              )}
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor={`${claimId}-notes`} className="text-xs">
                Notes
              </Label>
              <Textarea
                id={`${claimId}-notes`}
                rows={2}
                className="text-xs"
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder="Optional. What should a teammate know about this verdict?"
              />
            </div>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-4 py-2.5">
            <span className="text-[11px] text-muted-foreground">Press 1–4 to pick a verdict</span>
            <div className="flex gap-2">
              {state && state !== "NEEDS_REVIEW" ? (
                <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              ) : null}
              <Button type="submit" size="sm" className="h-8 text-xs" disabled={pending || !verdict}>
                {pending ? <Spinner /> : null}
                Record verdict
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </div>
  )
}

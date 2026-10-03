import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router"
import { toast } from "sonner"
import { ArrowLeftIcon, BookCheckIcon, ChevronDownIcon, FileSearchIcon, PlusIcon, QuoteIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { IssueStateBadge } from "@/components/status"
import { Badge } from "@/components/ui/badge"
import { Claims, Facts, Issues, Judgments, Observations, Representations, type Fact, type IssueState } from "@/lib/api"
import { errorMessage, formatDateTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

const verdicts = [
  { value: "SUPPORTED", label: "Supported", hint: "Matches your approved facts" },
  { value: "CONTRADICTED", label: "Wrong", hint: "Disagrees with an approved fact" },
  { value: "PARTIAL", label: "Partially correct", hint: "Some of it is right, some is not" },
  { value: "INSUFFICIENT_EVIDENCE", label: "Not enough information", hint: "No approved fact covers it" },
] as const

export function ObservationPage() {
  const { observationId = "" } = useParams()
  const { setActiveBusinessId, reloadOverview } = useWorkspace()
  const obs = useApi(`obs:${observationId}`, () => Observations.get(observationId))
  const observation = obs.data?.observation ?? null
  const businessId = observation?.business_id ?? null

  useEffect(() => {
    if (businessId) setActiveBusinessId(businessId)
  }, [businessId, setActiveBusinessId])

  const facts = useApi(businessId ? `facts:${businessId}` : null, () => Facts.list(businessId ?? ""))
  const issues = useApi(businessId ? `issues:${businessId}` : null, () => Issues.list(businessId ?? ""))
  const activeFacts = useMemo(() => (facts.data?.facts ?? []).filter((f) => f.status === "ACTIVE"), [facts.data])
  const stateByClaim = useMemo(() => new Map((issues.data?.issues ?? []).map((i) => [i.claim_id, i.state])), [issues.data])

  const [claimText, setClaimText] = useState("")
  const [savingClaim, setSavingClaim] = useState(false)

  if (obs.loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
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
          <Button asChild variant="outline">
            <Link to="/">See all businesses</Link>
          </Button>
        }
      />
    )
  }

  const claims = obs.data?.claims ?? []
  const citations = useMemo(() => obs.data?.citations ?? [], [obs.data])
  const representations = useApi(businessId ? `representations:${businessId}` : null, () =>
    Representations.list(businessId ?? ""),
  )
  const trackedByUrl = useMemo(() => {
    const rows = representations.data?.representations ?? []
    return { rows }
  }, [representations.data])
  const meta: Array<{ label: string; value: string }> = [
    { label: "Provider", value: observation.provider === "9router" ? "9Router" : sentenceCase(observation.provider) },
    { label: "Model", value: observation.observed_model ?? "Not reported" },
    { label: "Collected", value: formatDateTime(observation.collected_at) },
    { label: "Retrieval", value: sentenceCase(observation.retrieval_mode ?? "unknown") },
  ]

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2.5 text-muted-foreground">
          <Link to={`/businesses/${observation.business_id}/checks`}>
            <ArrowLeftIcon />
            Back to checks
          </Link>
        </Button>
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">AI answer</h1>
          <p className="max-w-prose text-sm text-muted-foreground">
            The answer exactly as collected. Copy each factual statement you want to verify into a claim, then judge it against your approved facts.
          </p>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <Card>
          <CardContent className="space-y-4">
            <QuoteIcon className="size-5 text-muted-foreground/60" />
            <p className="text-[15px] leading-7 whitespace-pre-wrap">{observation.answer_text}</p>
            {observation.raw_text ? (
              <Collapsible>
                <Separator className="mb-3" />
                <CollapsibleTrigger className="group flex items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring">
                  <ChevronDownIcon className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                  Raw provider response
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">{observation.raw_text}</pre>
                </CollapsibleContent>
              </Collapsible>
            ) : null}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardContent>
            <dl className="grid gap-4">
              {meta.map((m) => (
                <div key={m.label} className="grid gap-0.5">
                  <dt className="text-xs text-muted-foreground">{m.label}</dt>
                  <dd className="text-sm font-medium break-words">{m.value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Cited sources</h2>
          <p className="text-sm text-muted-foreground">What the provider returned with this answer, exactly as stored.</p>
        </div>
        {citations.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">No source citation was returned with this observation.</p>
        ) : (
          <Card>
            <CardContent>
              <ul className="divide-y">
                {citations.map((c, i) => (
                  <CitationRow key={`${c.uri ?? "null"}-${i}`} citation={c} businessId={observation.business_id} representations={trackedByUrl.rows} />
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </section>

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">Claims</h2>
          <p className="text-sm text-muted-foreground">Transcribe one statement at a time, in the AI&apos;s words.</p>
        </div>

        <Card>
          <CardContent>
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-start"
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
                rows={2}
                className="min-h-10 flex-1"
                value={claimText}
                onChange={(e) => setClaimText(e.currentTarget.value)}
                placeholder="Northstar costs $29 per month."
              />
              <Button type="submit" disabled={savingClaim || !claimText.trim()}>
                {savingClaim ? <Spinner /> : <PlusIcon />}
                Save claim
              </Button>
            </form>
          </CardContent>
        </Card>

        {claims.length === 0 ? (
          <p className="px-1 text-sm text-muted-foreground">No claims transcribed from this answer yet.</p>
        ) : (
          <ul className="space-y-4">
            {claims.map((c) => (
              <li key={c.id}>
                <ClaimReview
                  claimId={c.id}
                  text={c.text}
                  state={stateByClaim.get(c.id) ?? (issues.data ? "RESOLVED" : null)}
                  facts={activeFacts}
                  businessId={observation.business_id}
                  onRecorded={() => {
                    reloadOverview()
                    void issues.reload()
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
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
      : representations.find((r) => {
          try {
            const a = new URL(citation.uri as string)
            const b = new URL(r.source.url)
            return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "") && a.search === b.search
          } catch {
            return false
          }
        }) ?? null
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{citation.title ?? citation.uri ?? "Untitled source"}</p>
        <p className="truncate text-xs text-muted-foreground">
          {citation.uri ?? "No URI"}
          {citation.position !== null && citation.position !== undefined ? <span> · position {citation.position}</span> : null}
          {citation.attributed ? <span> · attributed</span> : null}
        </p>
      </div>
      {match ? (
        <Button asChild variant="link" size="sm" className="h-auto p-0">
          <Link to={`/businesses/${businessId}/representations/${match.binding_id}`}>View tracked representation</Link>
        </Button>
      ) : null}
    </li>
  )
}

function ClaimReview({
  claimId,
  text,
  state,
  facts,
  businessId,
  onRecorded,
}: {
  claimId: string
  text: string
  state: IssueState | "RESOLVED" | null
  facts: Fact[]
  businessId: string
  onRecorded: () => void
}) {
  const [verdict, setVerdict] = useState<string>("CONTRADICTED")
  const [notes, setNotes] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [open, setOpen] = useState(state === "NEEDS_REVIEW")
  const nav = useNavigate()

  useEffect(() => {
    if (state === "NEEDS_REVIEW") setOpen(true)
  }, [state])

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="gap-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="min-w-0 flex-1 text-[15px] leading-relaxed font-medium">{text}</CardTitle>
          {state === "RESOLVED" ? (
            <Badge variant="supported">Supported</Badge>
          ) : state ? (
            <IssueStateBadge state={state} />
          ) : null}
        </div>
        {state && state !== "NEEDS_REVIEW" && !open ? (
          <CardDescription>
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setOpen(true)}>
              Change verdict
            </Button>
          </CardDescription>
        ) : null}
      </CardHeader>

      {open ? (
        <form
          className="border-t"
          onSubmit={(e) => {
            e.preventDefault()
            setPending(true)
            Judgments.create(claimId, verdict, selected, notes || undefined)
              .then(() => {
                toast.success("Verdict recorded", {
                  description: verdict === "SUPPORTED" ? "Supported claims stay out of the issues inbox." : "It now shows in the issues inbox.",
                  action: { label: "Open issues", onClick: () => nav(`/businesses/${businessId}/issues`) },
                })
                setOpen(false)
                setNotes("")
                onRecorded()
              })
              .catch((err: unknown) => toast.error("Could not record the verdict", { description: errorMessage(err) }))
              .finally(() => setPending(false))
          }}
        >
          <div className="grid gap-6 px-5 py-5 md:grid-cols-2">
            <div className="grid content-start gap-3">
              <Label className="text-sm">Verdict</Label>
              <RadioGroup value={verdict} onValueChange={setVerdict} className="gap-2">
                {verdicts.map((v) => (
                  <Label
                    key={v.value}
                    htmlFor={`${claimId}-${v.value}`}
                    className={cn(
                      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors hover:bg-muted/50",
                      verdict === v.value && "border-primary/50 bg-primary/[0.04]",
                    )}
                  >
                    <RadioGroupItem id={`${claimId}-${v.value}`} value={v.value} className="mt-0.5" />
                    <span className="grid gap-1">
                      <span className="font-medium">{v.label}</span>
                      <span className="text-xs text-muted-foreground">{v.hint}</span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </div>

            <div className="grid content-start gap-3">
              <Label className="text-sm">Approved facts this claim touches</Label>
              {facts.length === 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                  <BookCheckIcon className="size-4" />
                  <span>
                    No active facts.{" "}
                    <Link to={`/businesses/${businessId}/truth`} className="font-medium text-foreground underline-offset-4 hover:underline">
                      Add one
                    </Link>
                  </span>
                </div>
              ) : (
                <div className="divide-y rounded-lg border">
                  {facts.map((f) => (
                    <Label key={f.id} htmlFor={`${claimId}-${f.id}`} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 font-normal hover:bg-muted/50">
                      <Checkbox
                        id={`${claimId}-${f.id}`}
                        checked={selected.includes(f.id)}
                        onCheckedChange={(checked) =>
                          setSelected(checked === true ? [...selected, f.id] : selected.filter((s) => s !== f.id))
                        }
                      />
                      <span className="min-w-0 flex-1 text-muted-foreground">{sentenceCase(f.predicate)}</span>
                      <span className="font-medium">{f.valueText}</span>
                    </Label>
                  ))}
                </div>
              )}

              <Label htmlFor={`${claimId}-notes`} className="mt-2 text-sm">
                Notes
              </Label>
              <Textarea
                id={`${claimId}-notes`}
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
                placeholder="Optional. What should a teammate know about this verdict?"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t bg-muted/30 px-5 py-3">
            {state && state !== "NEEDS_REVIEW" ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            ) : null}
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? <Spinner /> : null}
              Record verdict
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  )
}

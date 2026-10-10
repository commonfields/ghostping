import { useState } from "react"
import { useParams } from "react-router"
import { ASSAY_RETRIEVAL_LIMITATION, type AssayFact, type AssayFinding, type AssayRetrievalMode } from "@openrecord/contracts"
import { CheckIcon, ChevronDownIcon, FileSearchIcon, FlaskConicalIcon, GlobeIcon, ListChecksIcon, LoaderCircleIcon, PlayIcon, ScaleIcon, TriangleAlertIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EmptyState, PageHeader, Panel, PanelHeader, StepFlow, domainOf } from "@/components/page"
import { ProviderChip } from "@/components/status"
import { Spinner } from "@/components/spinner"
import { Assay, Providers, Questions } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { errorMessage, formatDateTime, sentenceCase } from "@/lib/format"
import { cn } from "@/lib/utils"

const human = (s: string) => sentenceCase(s).toLowerCase()

function Review({ label, choices, save }: { label: string; choices: readonly [string, string][]; save: (decision: string, reason: string) => Promise<unknown> }) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const review = async (decision: string) => {
    if (busy || !reason.trim()) return
    setBusy(true)
    setError(null)
    try { await save(decision, reason.trim()) } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-2 border-t bg-muted/30 px-4 py-3">
      <Label htmlFor={`reason-${label}`} className="text-[11px] text-muted-foreground">Review reason (required)</Label>
      <Textarea id={`reason-${label}`} rows={2} value={reason} onChange={e => setReason(e.target.value)} maxLength={4000} disabled={busy} placeholder="Why you made this call, in one line." />
      <div className="flex flex-wrap items-center gap-1.5">
        {choices.map(([decision, title], i) => (
          <Button key={decision} size="sm" variant={i === 0 ? "default" : "outline"} disabled={busy || !reason.trim()} onClick={() => void review(decision)}>
            {busy ? <Spinner /> : i === 0 ? <CheckIcon /> : null}
            {title}
          </Button>
        ))}
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

function FactEvidence({ fact }: { fact: AssayFact }) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{fact.subject}</span>
        <Badge variant="outline">{human(fact.fact_type)}</Badge>
      </div>
      <blockquote className="rounded-lg bg-muted/40 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">{fact.supporting_span}</blockquote>
      <div className="space-y-0.5 text-[11px] text-muted-foreground">
        <a className="flex items-center gap-1 break-all text-foreground hover:underline" href={fact.final_url ?? fact.source_url} target="_blank" rel="noreferrer">
          <GlobeIcon className="size-3 shrink-0" />
          {fact.final_url ?? fact.source_url}
        </a>
        {fact.final_url && fact.final_url !== fact.source_url ? <p className="text-xs">Requested source: <a className="underline" href={fact.source_url} target="_blank" rel="noreferrer">{fact.source_url}</a>{new URL(fact.final_url).origin !== new URL(fact.source_url).origin ? " (cross-origin redirect)" : ""}</p> : null}
        <p>Page snapshot: {fact.valid_from ? formatDateTime(fact.valid_from) : "unavailable"}</p>
      </div>
      {fact.source_links.length > 1 ? (
        <details className="group text-[11px]">
          <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"><ChevronDownIcon className="size-3 group-open:rotate-180" />All source evidence ({fact.source_links.length})</summary>
          <div className="mt-2 space-y-2">
            {fact.source_links.map(s => (
              <p key={s.sourceId}>
                <a className="underline" href={s.finalUrl ?? s.sourceUrl} target="_blank" rel="noreferrer">{s.finalUrl ?? s.sourceUrl}</a> · {s.snapshotAt}
                <span className="block whitespace-pre-wrap text-muted-foreground">{s.supportingSpan}</span>
              </p>
            ))}
          </div>
        </details>
      ) : null}
      <details className="group text-[11px]">
        <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"><ChevronDownIcon className="size-3 group-open:rotate-180" />Normalized value</summary>
        <pre className="mt-2 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(fact.normalized, null, 2)}</pre>
      </details>
    </div>
  )
}

const sampleTone = (s: AssayFinding["samples"][number]) => {
  const c = (s.comparison ?? "").toUpperCase()
  if (s.failureClass || s.status === "FAILED") return "bg-muted-foreground/30"
  if (c.includes("CONTRADICT")) return "bg-wrong"
  if (c.includes("MATCH") || c.includes("SUPPORT") || c.includes("CONSISTENT")) return "bg-supported"
  return "bg-unknown"
}

function FindingEvidence({ finding }: { finding: AssayFinding }) {
  const [openSample, setOpenSample] = useState<number | null>(null)
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant={finding.verdict.includes("CONTRADICT") ? "wrong" : finding.verdict.includes("INTERMITTENT") ? "partial" : "secondary"}>{sentenceCase(finding.verdict)}</Badge>
          <Badge variant="outline">{sentenceCase(finding.retrieval_class)}</Badge>
          <Badge variant="outline">{sentenceCase(finding.group_status)}</Badge>
        </div>
        <p className="text-[13px] font-medium">&ldquo;{finding.question}&rdquo;</p>
      </div>

      <div className="space-y-1.5 rounded-lg bg-muted/40 p-3">
        <div className="flex items-baseline justify-between text-xs">
          <span>
            <span className="font-semibold tabular-nums">{finding.contradict_count}/{finding.sample_count}</span> successful samples contradicted
          </span>
          <span className="text-[11px] text-muted-foreground">{finding.requested_n} requested · {finding.unclear_count} unclear</span>
        </div>
        <div className="flex flex-wrap gap-1" aria-label="Samples">
          {finding.samples.map(s => (
            <button
              key={s.sampleNumber}
              type="button"
              title={`Sample ${s.sampleNumber}: ${s.comparison ?? s.status}`}
              onClick={() => setOpenSample(openSample === s.sampleNumber ? null : s.sampleNumber)}
              className={cn("size-3.5 rounded-[4px] ring-offset-1 transition-shadow", sampleTone(s), openSample === s.sampleNumber && "ring-2 ring-foreground/40")}
            />
          ))}
          {finding.missing_samples.map(s => <span key={`m-${s.sampleNumber}`} title={`Sample ${s.sampleNumber} missing: ${s.failureClass}`} className="size-3.5 rounded-[4px] border border-dashed border-muted-foreground/50" />)}
        </div>
        <p className="text-[11px] text-muted-foreground">{finding.verification_eligible ? "Eligible for retrieval verification." : "Not eligible for retrieval verification."}</p>
        {finding.retrieval_class !== "RETRIEVAL_ENABLED" ? <p className="text-xs text-muted-foreground">{ASSAY_RETRIEVAL_LIMITATION}</p> : null}
      </div>

      <FactEvidence fact={finding.fact} />

      <div className="space-y-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Samples</span>
        <ul className="divide-y overflow-hidden rounded-lg bg-muted/30">
          {finding.samples.map(sample => (
            <li key={sample.sampleNumber} className={cn("space-y-1.5 px-3 py-2", openSample === sample.sampleNumber && "bg-review-soft/60")}>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span aria-hidden className={cn("size-2 rounded-full", sampleTone(sample))} />
                <span className="font-medium">Sample {sample.sampleNumber}{sample.synthetic ? " (synthetic fixture)" : ""}</span>
                <ProviderChip provider={sample.provider} model={sample.observedModel} />
                <span className="text-muted-foreground">{sample.comparison ? human(sample.comparison) : human(sample.status)} · retrieval: {sample.retrievalMode ? human(sample.retrievalMode) : "unknown"}</span>
              </div>
              {sample.failureClass ? <p className="text-[11px] text-partial">Missing sample: {sample.failureClass}</p> : null}
              <p className="text-xs leading-relaxed whitespace-pre-wrap">{sample.supportingSpan || sample.answer}</p>
              <details className="group">
                <summary className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"><ChevronDownIcon className="size-3 group-open:rotate-180" />Full answer and provenance</summary>
                <pre className="mt-1.5 overflow-auto rounded-md bg-card p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(sample, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      </div>

      <details className="group text-[11px]">
        <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"><ChevronDownIcon className="size-3 group-open:rotate-180" />Source diagnosis (likely sources)</summary>
        <pre className="mt-1.5 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap">{JSON.stringify(finding.source_diagnosis, null, 2)}</pre>
      </details>
      {finding.verdict === "OBSERVED_INTERMITTENT" ? <p className="text-xs text-muted-foreground">Intermittent observation. Human review only; no automatic outreach eligibility.</p> : null}
    </div>
  )
}

const statusTone = (status: string) => {
  const s = status.toUpperCase()
  if (s.includes("FAIL")) return "wrong" as const
  if (s.includes("QUEUED") || s.includes("RUNNING") || s.includes("PENDING") || s.includes("FETCHING")) return "review" as const
  if (s.includes("PARTIAL")) return "partial" as const
  if (s.includes("DONE") || s.includes("SUCCE") || s.includes("FETCHED") || s.includes("COMPLETE")) return "supported" as const
  return "secondary" as const
}

export function AssayPage() {
  const { id = "" } = useParams()
  const queue = useApi(`assay:${id}`, () => Assay.queue(id), { pollMs: 3000 })
  const questions = useApi(`assay-questions:${id}`, () => Questions.list(id))
  const providers = useApi("assay-providers", () => Providers.list())
  const [url, setUrl] = useState("")
  const [subject, setSubject] = useState("")
  const [plans, setPlans] = useState("")
  const [capabilities, setCapabilities] = useState("")
  const [questionId, setQuestionId] = useState("")
  const [provider, setProvider] = useState<"mock" | "9router">("9router")
  const [model, setModel] = useState("")
  const [retrieval, setRetrieval] = useState<typeof AssayRetrievalMode.Type>("NONE")
  const [n, setN] = useState("5")
  const [busy, setBusy] = useState<"source" | "run" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<"facts" | "findings">("facts")
  const action = async (kind: "source" | "run", run: () => Promise<unknown>) => {
    if (busy) return
    setBusy(kind); setError(null)
    try { await run(); await queue.reload() } catch (e) { setError(errorMessage(e)) } finally { setBusy(null) }
  }
  const terms = (s: string) => s.split(",").map(t => t.trim()).filter(Boolean)
  const enabledProviders = providers.data?.providers.filter(p => p.enabled && (p.id !== "mock" || providers.data?.assaySyntheticEnabled)) ?? []
  const models = enabledProviders.find(p => p.id === provider)?.models ?? []
  const q = queue.data
  const sources = q?.sources ?? []
  const groups = q?.groups ?? []
  const facts = q?.facts ?? []
  const findings = q?.findings ?? []
  const runningGroups = groups.filter(g => statusTone(g.status) === "review").length

  return (
    <div className="space-y-6 pb-4">
      <PageHeader title="Prospect assay" description="Public-source proposals and repeated observations held for human review. Answers collected before the page snapshot are not compared." />

      <StepFlow
        steps={[
          { key: "src", icon: <GlobeIcon />, label: "Public sources", hint: "Approve a page to fetch", value: queue.loading ? undefined : sources.length, state: sources.length ? "done" : "current" },
          { key: "facts", icon: <ListChecksIcon />, label: "Facts to confirm", hint: "Proposed from fetched text", value: queue.loading ? undefined : facts.length, state: facts.length ? "current" : sources.length ? "done" : "todo" },
          { key: "obs", icon: <FlaskConicalIcon />, label: "Observations", hint: runningGroups ? `${runningGroups} running` : "Repeat one question N times", value: queue.loading ? undefined : groups.length, state: groups.length ? "done" : "todo" },
          { key: "find", icon: <ScaleIcon />, label: "Findings to review", hint: "Samples compared to confirmed facts", value: queue.loading ? undefined : findings.length, state: findings.length ? "current" : "todo" },
        ]}
      />

      {queue.error || error ? (
        <p role="alert" className="flex items-center gap-2 rounded-lg bg-wrong-soft px-3 py-2 text-xs text-wrong">
          <TriangleAlertIcon className="size-3.5" />
          {error ?? errorMessage(queue.error)}
        </p>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <Panel>
          <PanelHeader title="Review queue" description="Nothing is used until a person confirms it">
            <Tabs value={tab} onValueChange={v => setTab(v as "facts" | "findings")}>
              <TabsList>
                <TabsTrigger value="facts">Facts <span className="tabular-nums text-muted-foreground">{facts.length}</span></TabsTrigger>
                <TabsTrigger value="findings">Findings <span className="tabular-nums text-muted-foreground">{findings.length}</span></TabsTrigger>
              </TabsList>
            </Tabs>
          </PanelHeader>
          <div className="space-y-3 p-4 pt-3">
            {queue.loading ? (
              <Skeleton className="h-48" />
            ) : tab === "facts" ? (
              <section className="space-y-3" aria-label="Facts awaiting confirmation">
                <h2 className="sr-only">Facts awaiting confirmation</h2>
                {!facts.length ? (
                  <EmptyState icon={<ListChecksIcon />} title="No facts awaiting confirmation" description="Queue a public source to propose facts. Unconfirmed facts never take part in comparisons." className="py-10" />
                ) : facts.map(fact => (
                  <article key={fact.id} className="overflow-hidden rounded-lg ring-1 ring-border">
                    <div className="p-4"><FactEvidence fact={fact} /></div>
                    <Review label={fact.id} choices={[["CONFIRMED", "Confirm fact"], ["INCORRECT_EXTRACTION", "Incorrect extraction"], ["AMBIGUOUS", "Ambiguous"]]} save={async (decision, reason) => { await Assay.reviewFact(id, fact.id, { decision: decision as "CONFIRMED" | "INCORRECT_EXTRACTION" | "AMBIGUOUS", reason }); await queue.reload() }} />
                  </article>
                ))}
              </section>
            ) : (
              <section className="space-y-3" aria-label="Findings awaiting review">
                <h2 className="sr-only">Findings awaiting review</h2>
                {!findings.length ? (
                  <EmptyState icon={<ScaleIcon />} title="No candidate findings awaiting review" description="Run repeated observations for a question. Unconfirmed facts do not contribute to comparisons." className="py-10" />
                ) : findings.map(finding => (
                  <article key={finding.id} className="overflow-hidden rounded-lg ring-1 ring-border">
                    <div className="p-4"><FindingEvidence finding={finding} /></div>
                    <Review label={finding.id} choices={[["REVIEWED_CORRECT", "Correct"], ["REVIEWED_FALSE_POSITIVE", "False positive"], ["REVIEWED_NOT_MEANINGFUL", "Not meaningful"]]} save={async (decision, reason) => { await Assay.reviewFinding(id, finding.id, { decision: decision as "REVIEWED_CORRECT" | "REVIEWED_FALSE_POSITIVE" | "REVIEWED_NOT_MEANINGFUL", reason }); await queue.reload() }} />
                  </article>
                ))}
              </section>
            )}
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="Approve a public source for fetching" icon={<GlobeIcon />} />
            <form className="grid gap-2.5 p-4 pt-3" onSubmit={e => { e.preventDefault(); void action("source", () => Assay.registerSource(id, { url, subject, planTerms: terms(plans), capabilityTerms: terms(capabilities) })) }}>
              <div className="grid gap-1"><Label htmlFor="source-url" className="text-[11px]">Public source URL</Label><Input id="source-url" type="url" placeholder="https://competitor.com/pricing" value={url} onChange={e => setUrl(e.target.value)} /></div>
              <div className="grid gap-1"><Label htmlFor="source-subject" className="text-[11px]">Price subject (business or plan)</Label><Input id="source-subject" value={subject} onChange={e => setSubject(e.target.value)} /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1"><Label htmlFor="plan-terms" className="text-[11px]">Plan names</Label><Input id="plan-terms" placeholder="Pro, Team" value={plans} onChange={e => setPlans(e.target.value)} /></div>
                <div className="grid gap-1"><Label htmlFor="capability-terms" className="text-[11px]">Capabilities</Label><Input id="capability-terms" placeholder="SSO, API" value={capabilities} onChange={e => setCapabilities(e.target.value)} /></div>
              </div>
              <p className="text-[11px] text-muted-foreground">Comma separated. Only this URL is fetched.</p>
              <Button type="submit" size="sm" disabled={busy !== null || !url.trim() || !subject.trim()}>
                {busy === "source" ? <Spinner /> : <FileSearchIcon />}
                Queue source fetch
              </Button>
            </form>
            {sources.length ? (
              <ul className="border-t p-2">
                {sources.map(source => (
                  <li key={source.id} className="space-y-1 rounded-md px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">{domainOf(source.url)}</span>
                      <Badge variant={statusTone(source.status)}>{sentenceCase(source.status)}</Badge>
                    </div>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {source.failure_class ? `${source.failure_class} · ` : ""}
                      {source.fetched_at ? `Fetched ${formatDateTime(source.fetched_at)} from ${source.final_url ?? source.url}` : source.url}
                    </p>
                    {source.fetched_text ? (
                      <details className="group text-[11px]">
                        <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"><ChevronDownIcon className="size-3 group-open:rotate-180" />Fetched public text</summary>
                        <pre className="mt-1 max-h-48 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] whitespace-pre-wrap">{source.fetched_text}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader title="Run repeated observations" icon={<FlaskConicalIcon />} />
            <div className="grid gap-2.5 p-4 pt-3">
              <div className="grid gap-1"><Label className="text-[11px]">Buyer question</Label><Select value={questionId} onValueChange={setQuestionId}><SelectTrigger aria-label="Buyer question" className="w-full"><SelectValue placeholder="Choose an existing question" /></SelectTrigger><SelectContent>{questions.data?.questions.map(q => <SelectItem key={q.id} value={q.id}>{q.prompt}</SelectItem>)}</SelectContent></Select></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1"><Label className="text-[11px]">Provider</Label><Select value={provider} onValueChange={v => { setProvider(v as "mock" | "9router"); setModel(""); setRetrieval("NONE") }}><SelectTrigger aria-label="Provider" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{enabledProviders.map(p => <SelectItem key={p.id} value={p.id}>{p.id === "9router" ? "9Router" : sentenceCase(p.id)}</SelectItem>)}</SelectContent></Select></div>
                <div className="grid gap-1"><Label htmlFor="sample-count" className="text-[11px]">Samples (1–20)</Label><Input id="sample-count" type="number" min={1} max={20} value={n} onChange={e => setN(e.target.value)} /></div>
              </div>
              {provider === "9router" ? <div className="grid gap-1"><Label className="text-[11px]">Model</Label><Select value={model} onValueChange={setModel}><SelectTrigger aria-label="Model" className="w-full"><SelectValue placeholder="Choose a model" /></SelectTrigger><SelectContent>{models.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select></div> : <p className="text-xs text-muted-foreground">Mock observations are synthetic fixtures.</p>}
              <div className="grid gap-1"><Label className="text-[11px]">Requested retrieval</Label><Select value={retrieval} onValueChange={v => setRetrieval(v as typeof AssayRetrievalMode.Type)}><SelectTrigger aria-label="Requested retrieval" className="w-full"><SelectValue /></SelectTrigger><SelectContent>{(provider === "mock" ? ["NONE", "WEB_SEARCH", "PROVIDER_GROUNDING", "MANUAL_CAPTURE"] : ["NONE"]).map(m => <SelectItem key={m} value={m}>{human(m)}</SelectItem>)}</SelectContent></Select></div>
              {enabledProviders.length === 0 && !providers.loading ? <p className="text-[11px] text-partial">No provider is enabled on this server.</p> : null}
              <Button size="sm" disabled={busy !== null || !questionId || !enabledProviders.some(p => p.id === provider) || (provider === "9router" && !model) || !Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 20} onClick={() => void action("run", () => Assay.run(id, { questionId, provider, requestedModel: provider === "9router" ? model : null, retrievalMode: retrieval, n: Number(n) }))}>
                {busy === "run" ? <Spinner /> : <PlayIcon />}
                Queue observations
              </Button>
            </div>
            {groups.length ? (
              <ul className="border-t p-2">
                {groups.map(group => (
                  <li key={group.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
                    {statusTone(group.status) === "review" ? <LoaderCircleIcon className="size-3.5 animate-spin text-review" /> : <FlaskConicalIcon className="size-3.5 text-muted-foreground" />}
                    <span className="flex-1">{group.n} samples</span>
                    <Badge variant={statusTone(group.status)}>{sentenceCase(group.status)}</Badge>
                    {group.missing_samples.length ? <span className="text-[11px] text-partial" title={group.missing_samples.map(s => `Sample ${s.sampleNumber}: ${s.failureClass}`).join("; ")}>{group.missing_samples.length} missing</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  )
}

import { useState } from "react"
import { useParams } from "react-router"
import { ASSAY_RETRIEVAL_LIMITATION, type AssayFact, type AssayFinding, type AssayRetrievalMode } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeader } from "@/components/page"
import { Assay, Providers, Questions } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { errorMessage } from "@/lib/format"

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
  return <div className="space-y-3">
    <Label htmlFor={`reason-${label}`}>Review reason</Label>
    <Textarea id={`reason-${label}`} value={reason} onChange={e => setReason(e.target.value)} maxLength={4000} disabled={busy} />
    <div className="flex flex-wrap gap-2">{choices.map(([decision, title]) => <Button key={decision} variant="outline" disabled={busy || !reason.trim()} onClick={() => void review(decision)}>{title}</Button>)}</div>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </div>
}
function FactEvidence({ fact }: { fact: AssayFact }) {
  return <div className="space-y-2">
    <p className="font-medium">{fact.subject} / {fact.fact_type.toLowerCase().replaceAll("_", " ")}</p>
    <a className="break-all underline" href={fact.final_url ?? fact.source_url} target="_blank" rel="noreferrer">{fact.final_url ?? fact.source_url}</a>
    {fact.final_url && fact.final_url !== fact.source_url ? <p className="text-sm">Requested source: <a className="underline" href={fact.source_url} target="_blank" rel="noreferrer">{fact.source_url}</a>{new URL(fact.final_url).origin !== new URL(fact.source_url).origin ? " (cross-origin redirect)" : ""}</p> : null}
    <p className="text-sm text-muted-foreground">Page snapshot: {fact.valid_from ?? "unavailable"}</p>
    {fact.source_links.length > 1 ? <details><summary>All source evidence</summary>{fact.source_links.map(s => <p key={s.sourceId}><a className="underline" href={s.finalUrl ?? s.sourceUrl} target="_blank" rel="noreferrer">{s.finalUrl ?? s.sourceUrl}</a> / {s.snapshotAt}<span className="block whitespace-pre-wrap">{s.supportingSpan}</span></p>)}</details> : null}
    <blockquote className="border-l-2 pl-3 whitespace-pre-wrap">{fact.supporting_span}</blockquote>
    <pre className="overflow-auto whitespace-pre-wrap text-sm">{JSON.stringify(fact.normalized, null, 2)}</pre>
  </div>
}
function FindingEvidence({ finding }: { finding: AssayFinding }) {
  return <div className="space-y-4">
    <p className="font-medium">{finding.question}</p>
    <p>{finding.contradict_count}/{finding.sample_count} successful samples contradicted; {finding.requested_n} requested. {finding.verdict.toLowerCase().replaceAll("_", " ")}.</p>
    <p>{finding.group_status.toLowerCase().replaceAll("_", " ")}. {finding.unclear_count} unclear samples.</p>
    <p>{finding.retrieval_class.toLowerCase().replaceAll("_", " ")}. {finding.verification_eligible ? "Eligible for retrieval verification." : "Not eligible for retrieval verification."}</p>
    {finding.retrieval_class !== "RETRIEVAL_ENABLED" ? <p className="text-sm text-muted-foreground">{ASSAY_RETRIEVAL_LIMITATION}</p> : null}
    <FactEvidence fact={finding.fact} />
    {finding.samples.map(sample => <div key={sample.sampleNumber} className="border-l pl-3 space-y-1">
      <p>Sample {sample.sampleNumber}{sample.synthetic ? " (synthetic fixture)" : ""}: {sample.comparison ?? sample.status}; retrieval: {sample.retrievalMode ?? "unknown"}</p>
      {sample.failureClass ? <p>Missing sample: {sample.failureClass}</p> : null}
      <blockquote className="whitespace-pre-wrap">{sample.supportingSpan || sample.answer}</blockquote>
      <details><summary className="cursor-pointer text-sm">Full answer and provenance</summary><pre className="overflow-auto whitespace-pre-wrap text-sm">{JSON.stringify(sample, null, 2)}</pre></details>
    </div>)}
    <details><summary className="cursor-pointer">Source diagnosis (likely sources)</summary><pre className="overflow-auto whitespace-pre-wrap text-sm">{JSON.stringify(finding.source_diagnosis, null, 2)}</pre></details>
    {finding.verdict === "OBSERVED_INTERMITTENT" ? <p className="text-sm text-muted-foreground">Intermittent observation. Human review only; no automatic outreach eligibility.</p> : null}
  </div>
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const action = async (run: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(null)
    try { await run(); await queue.reload() } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  const terms = (s: string) => s.split(",").map(t => t.trim()).filter(Boolean)
  const enabledProviders = providers.data?.providers.filter(p => p.enabled && (p.id !== "mock" || providers.data?.assaySyntheticEnabled)) ?? []
  const models = enabledProviders.find(p => p.id === provider)?.models ?? []
  return <div className="space-y-8">
    <PageHeader title="Prospect assay" description="Public-source proposals and repeated observations held for human review." actions={<Button variant="outline" onClick={() => void queue.reload()}>Refresh</Button>} />
    <p className="text-sm text-muted-foreground">Answers collected before the page snapshot are not compared.</p>
    {queue.loading ? <p>Loading assay evidence…</p> : null}
    {queue.error || error ? <p role="alert" className="text-destructive">{error ?? errorMessage(queue.error)}</p> : null}
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Approve a public source for fetching</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2"><Label htmlFor="source-url">Public source URL</Label><Input id="source-url" type="url" value={url} onChange={e => setUrl(e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="source-subject">Price subject (business or plan)</Label><Input id="source-subject" value={subject} onChange={e => setSubject(e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="plan-terms">Plan names, comma separated</Label><Input id="plan-terms" value={plans} onChange={e => setPlans(e.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="capability-terms">Capability names, comma separated</Label><Input id="capability-terms" value={capabilities} onChange={e => setCapabilities(e.target.value)} /></div>
      </div>
      <Button disabled={busy || !url.trim() || !subject.trim()} onClick={() => void action(() => Assay.registerSource(id, { url, subject, planTerms: terms(plans), capabilityTerms: terms(capabilities) }))}>Queue source fetch</Button>
      {queue.data?.sources.map(source => <div key={source.id}><p className="break-all text-sm">{source.url}: {source.status}{source.failure_class ? ` (${source.failure_class})` : ""}</p>
        {source.fetched_at ? <p className="text-sm text-muted-foreground">Fetched {source.fetched_at} from {source.final_url ?? source.url}</p> : null}
        {source.fetched_text ? <details><summary className="cursor-pointer text-sm">Fetched public text</summary><pre className="whitespace-pre-wrap text-sm">{source.fetched_text}</pre></details> : null}</div>)}
    </section>
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Run repeated observations</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2"><Label>Buyer question</Label><Select value={questionId} onValueChange={setQuestionId}><SelectTrigger aria-label="Buyer question"><SelectValue placeholder="Choose an existing question" /></SelectTrigger><SelectContent>{questions.data?.questions.map(q => <SelectItem key={q.id} value={q.id}>{q.prompt}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label>Provider</Label><Select value={provider} onValueChange={v => { setProvider(v as "mock" | "9router"); setModel(""); setRetrieval("NONE") }}><SelectTrigger aria-label="Provider"><SelectValue /></SelectTrigger><SelectContent>{enabledProviders.map(p => <SelectItem key={p.id} value={p.id}>{p.id}</SelectItem>)}</SelectContent></Select></div>
        {provider === "9router" ? <div className="space-y-2"><Label>Model</Label><Select value={model} onValueChange={setModel}><SelectTrigger aria-label="Model"><SelectValue placeholder="Choose a model" /></SelectTrigger><SelectContent>{models.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select></div> : <p className="text-sm text-muted-foreground">Mock observations are synthetic fixtures.</p>}
        <div className="space-y-2"><Label>Requested retrieval</Label><Select value={retrieval} onValueChange={v => setRetrieval(v as typeof AssayRetrievalMode.Type)}><SelectTrigger aria-label="Requested retrieval"><SelectValue /></SelectTrigger><SelectContent>{(provider === "mock" ? ["NONE", "WEB_SEARCH", "PROVIDER_GROUNDING", "MANUAL_CAPTURE"] : ["NONE"]).map(m => <SelectItem key={m} value={m}>{m.toLowerCase().replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div>
        <div className="space-y-2"><Label htmlFor="sample-count">Samples (1–20)</Label><Input id="sample-count" type="number" min={1} max={20} value={n} onChange={e => setN(e.target.value)} /></div>
      </div>
      <Button disabled={busy || !questionId || !enabledProviders.some(p => p.id === provider) || (provider === "9router" && !model) || !Number.isInteger(Number(n)) || Number(n) < 1 || Number(n) > 20} onClick={() => void action(() => Assay.run(id, { questionId, provider, requestedModel: provider === "9router" ? model : null, retrievalMode: retrieval, n: Number(n) }))}>Queue observations</Button>
      {queue.data?.groups.map(group => <p key={group.id} className="text-sm">{group.n} samples: {group.status}. {group.missing_samples.map(s => `Sample ${s.sampleNumber}: ${s.failureClass}`).join("; ")}</p>)}
    </section>
    <section className="space-y-5"><h2 className="text-lg font-medium">Facts awaiting confirmation</h2>
      {queue.data && !queue.data.facts.length ? <p className="text-sm text-muted-foreground">No facts awaiting confirmation. Queue a public source to propose facts.</p> : null}
      {queue.data?.facts.map(fact => <article key={fact.id} className="border-t pt-5 space-y-4"><FactEvidence fact={fact} />
        <Review label={fact.id} choices={[["CONFIRMED", "Confirm fact"], ["INCORRECT_EXTRACTION", "Incorrect extraction"], ["AMBIGUOUS", "Ambiguous"]]} save={async (decision, reason) => { await Assay.reviewFact(id, fact.id, { decision: decision as "CONFIRMED" | "INCORRECT_EXTRACTION" | "AMBIGUOUS", reason }); await queue.reload() }} />
      </article>)}
    </section>
    <section className="space-y-5"><h2 className="text-lg font-medium">Findings awaiting review</h2>
      {queue.data && !queue.data.findings.length ? <p className="text-sm text-muted-foreground">No candidate findings awaiting review. Unconfirmed facts do not contribute to comparisons.</p> : null}
      {queue.data?.findings.map(finding => <article key={finding.id} className="border-t pt-5 space-y-5"><FindingEvidence finding={finding} />
        <Review label={finding.id} choices={[["REVIEWED_CORRECT", "Correct"], ["REVIEWED_FALSE_POSITIVE", "False positive"], ["REVIEWED_NOT_MEANINGFUL", "Not meaningful"]]} save={async (decision, reason) => { await Assay.reviewFinding(id, finding.id, { decision: decision as "REVIEWED_CORRECT" | "REVIEWED_FALSE_POSITIVE" | "REVIEWED_NOT_MEANINGFUL", reason }); await queue.reload() }} />
      </article>)}
    </section>
  </div>
}

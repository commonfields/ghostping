// One client's record, operated by the agency: identity, three approved
// facts with one question each, checks on the live surface, human review,
// agency actions, the weekly re-check and its outcome, and the share URL.
import { useState } from "react"
import { useParams } from "react-router"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PageHeader } from "@/components/page"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, formatDate, formatDateTime } from "@/lib/format"
import { ApiError } from "@/lib/api"
import {
  DECISION_LABELS, OUTCOME_LABELS, publicRecordPath, Records, RUN_STATUS_LABELS,
  type Decision, type OperatorRecord, type RecordCheck, type RecordResponse, type ValueType,
} from "@/lib/record"
import { useApi } from "@/lib/use-api"

const REFUSALS: Record<string, string> = {
  NoApprovedFacts: "Approve at least one fact before running a check.",
  RunInProgress: "A check is already running for this client.",
  NoBaseline: "Run the first check before a weekly re-check.",
  BaselineLocked: "A weekly re-check already compares against the first check, so the first check cannot be redone.",
  ItemSuperseded: "This fact was edited since; approve the current version.",
  FactsManagedByRepository: "This client's facts are managed by a repository manifest.",
  FixtureProviderDisabled: "The test fixture provider is disabled on this server.",
  Conflict: "Someone else just changed this. Reload and try again.",
}
const failure = (e: unknown) => {
  if (e instanceof ApiError && typeof e.body["reason"] === "string") return REFUSALS[e.body["reason"]] ?? e.body["reason"]
  return errorMessage(e)
}
const FAILURES: Record<string, string> = {
  PROVIDER_AUTH: "The provider rejected OpenRecord's credentials. Check GEMINI_API_KEY on the worker.",
  PROVIDER_UNSUPPORTED: "The provider is not configured for this model. Check GEMINI_API_KEY and GEMINI_MODEL on the worker.",
  PROVIDER_RATE_LIMITED: "The provider rate-limited the request.",
  PROVIDER_TIMEOUT: "The provider timed out.",
  PROVIDER_UNAVAILABLE: "The provider was unavailable.",
  PROVIDER_MALFORMED: "The provider returned an unreadable or oversized response.",
  PROVIDER_CONTRACT_MISMATCH: "The provider returned no usable answer (for example a blocked response).",
  WORKER_LOST: "The worker stopped before this check finished. Nothing was observed.",
}

function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    try { await fn(); await reload(); if (success) toast.success(success) } catch (e) { toast.error(failure(e)) } finally { setBusy(false) }
  }
  return { busy, run }
}

function Identity({ record, reload }: { record: OperatorRecord; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(record.profile.name)
  const [website, setWebsite] = useState(record.profile.websiteUrl)
  const { busy, run } = useAction(reload)
  if (!editing) {
    return <p className="text-sm text-muted-foreground">
      <a className="underline" href={record.profile.websiteUrl} target="_blank" rel="noreferrer">{record.profile.websiteUrl}</a>
      {record.profile.engagement !== "CLIENT" ? ` · ${record.profile.engagement}` : ""}
      {" · "}<button className="underline" onClick={() => setEditing(true)}>Edit client</button>
    </p>
  }
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); void run(() => Records.update(record.profile.businessId, { name: name.trim(), websiteUrl: website.trim() }), "Client updated").then(() => setEditing(false)) }}>
      <div className="grid gap-1"><Label htmlFor="name">Client name</Label><Input id="name" value={name} onChange={e => setName(e.target.value)} /></div>
      <div className="grid gap-1"><Label htmlFor="site">Website</Label><Input id="site" type="url" value={website} onChange={e => setWebsite(e.target.value)} /></div>
      <Button type="submit" disabled={busy}>Save</Button>
      <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
    </form>
  )
}

function SlotEditor({ clientId, clientName, slot, current, reload }: {
  clientId: string; clientName: string; slot: 1 | 2 | 3; current: OperatorRecord["slots"][number] | undefined; reload: () => Promise<void>
}) {
  const item = current?.item
  const [label, setLabel] = useState(item?.fact.predicate ?? "")
  const [value, setValue] = useState(item?.fact.valueText ?? "")
  const [valueType, setValueType] = useState<ValueType>(item?.fact.valueType ?? "TEXT")
  const [source, setSource] = useState(item?.sourceUrl ?? "https://")
  const [question, setQuestion] = useState(item?.question.prompt ?? "")
  const { busy, run } = useAction(reload)
  const dirty = !item || label !== item.fact.predicate || value !== item.fact.valueText || valueType !== item.fact.valueType || source !== item.sourceUrl || question !== item.question.prompt
  const save = () => run(() => Records.saveSlot(clientId, slot, {
    subject: item?.fact.subject ?? clientName, predicate: label.trim(), valueText: value.trim(), valueType, sourceUrl: source.trim(), question: question.trim(),
  }), "Saved. Approve this version before it is checked.")
  return (
    <form className="grid gap-3" onSubmit={e => { e.preventDefault(); void save() }}>
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_10rem]">
        <div className="grid gap-1"><Label htmlFor={`label-${slot}`}>Fact</Label><Input id={`label-${slot}`} placeholder="Check-in time" value={label} onChange={e => setLabel(e.target.value)} maxLength={200} /></div>
        <div className="grid gap-1"><Label htmlFor={`value-${slot}`}>Approved value</Label><Input id={`value-${slot}`} placeholder="3:00 PM" value={value} onChange={e => setValue(e.target.value)} maxLength={500} /></div>
        <div className="grid gap-1"><Label>Type</Label>
          <Select value={valueType} onValueChange={v => setValueType(v as ValueType)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{(["TEXT", "BOOLEAN", "NUMBER", "CURRENCY", "DATE", "URL", "ENUM"] as const).map(t => <SelectItem key={t} value={t}>{t.toLowerCase()}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-1"><Label htmlFor={`source-${slot}`}>Source URL (where this fact is published)</Label><Input id={`source-${slot}`} type="url" value={source} onChange={e => setSource(e.target.value)} maxLength={2000} /></div>
      <div className="grid gap-1"><Label htmlFor={`question-${slot}`}>Question a buyer would ask</Label><Input id={`question-${slot}`} placeholder={`What time is check-in at ${clientName}?`} value={question} onChange={e => setQuestion(e.target.value)} maxLength={500} /></div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={busy || !dirty || !label.trim() || !value.trim() || !question.trim()}>{item ? "Save new version" : "Save fact"}</Button>
        {item && !item.approval ? <Button type="button" disabled={busy || dirty} onClick={() => void run(() => Records.approve(clientId, item.id), "Fact approved")}>Approve fact</Button> : null}
        {item?.approval ? <span className="text-sm text-muted-foreground">Approved {formatDate(item.approval.approvedAt)}</span> : item ? <span className="text-sm text-amber-700">Not approved: it will not be checked or shown to the client.</span> : null}
      </div>
      {item && (current?.history.length ?? 0) > 1 ? <p className="text-xs text-muted-foreground">Version {current!.history.length}. Earlier checks keep the question and fact they used; a changed question or fact makes the next comparison indeterminate.</p> : null}
    </form>
  )
}

function Review({ clientId, check, reload }: { clientId: string; check: RecordCheck; reload: () => Promise<void> }) {
  const [note, setNote] = useState("")
  const { busy, run } = useAction(reload)
  if (check.status === "QUEUED" || check.status === "RUNNING") return <p className="text-sm text-muted-foreground">Check {check.status.toLowerCase()}…</p>
  if (check.status === "FAILED" || !check.observation) {
    return <p className="text-sm text-amber-700">Check failed: {FAILURES[check.failureClass ?? ""] ?? check.failureDetailSafe ?? check.failureClass}. It shows as “could not be completed”; run a new check to try again.</p>
  }
  const o = check.observation
  return (
    <div className="space-y-3">
      <blockquote className="whitespace-pre-wrap rounded-md border-l-4 bg-muted/50 px-4 py-3">{o.answerText}</blockquote>
      <p className="text-xs text-muted-foreground">
        {check.surface} · {o.modelVersion ?? o.observedModel ?? o.requestedModel ?? "model unknown"} · {formatDateTime(o.collectedAt)} ·{" "}
        {check.retrievalObserved ? <span>live web retrieval used</span> : <strong className="text-amber-700">{check.retrievalRequested ? "retrieval requested but not used" : "no live web retrieval"}</strong>}
        {o.synthetic ? <strong className="text-amber-700"> · synthetic fixture</strong> : null}
      </p>
      {o.citations.length ? <ol className="list-decimal pl-5 text-sm">{o.citations.map((c, i) => <li key={i}>{c.uri ? <a className="break-all underline" href={c.uri} target="_blank" rel="noreferrer">{c.title ?? c.uri}</a> : c.title}</li>)}</ol> : <p className="text-sm text-muted-foreground">No sources cited.</p>}
      <div className="space-y-2 rounded-md border p-3">
        <p className="text-sm">{check.judgment ? <>Your judgment: <strong>{DECISION_LABELS[check.judgment.decision]}</strong> ({formatDateTime(check.judgment.reviewedAt)}){check.judgments.length > 1 ? ` · corrected ${check.judgments.length - 1}×, history kept` : ""}</> : <strong>Needs your review. It stays private until you judge it.</strong>}</p>
        <Textarea placeholder="Internal note (never shown to the client)" value={note} onChange={e => setNote(e.target.value)} maxLength={2000} />
        <div className="flex flex-wrap gap-2">
          {(["MATCHES", "CONTRADICTS", "UNKNOWN"] as Decision[]).map(d => (
            <Button key={d} size="sm" variant={check.judgment?.decision === d ? "default" : "outline"} disabled={busy}
              onClick={() => void run(() => Records.judge(clientId, o.id, d, note.trim() || null), `Marked ${DECISION_LABELS[d].toLowerCase()}`).then(() => setNote(""))}>{DECISION_LABELS[d]}</Button>
          ))}
        </div>
      </div>
    </div>
  )
}

function checkFor(record: OperatorRecord, runId: string | undefined, slot: number) {
  const run = record.runs.find(r => r.id === runId)
  const versions = new Set(record.slots.find(s => s.slot === slot)?.history.map(h => h.id) ?? [])
  return run?.checks.find(c => versions.has(c.itemId)) ?? null
}

function ActionForm({ record, reload }: { record: OperatorRecord; reload: () => Promise<void> }) {
  const [slot, setSlot] = useState("all")
  const [note, setNote] = useState("")
  const [link, setLink] = useState("")
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10))
  const { busy, run } = useAction(reload)
  const submit = () => run(() => Records.action(record.profile.businessId, {
    slot: slot === "all" ? null : (Number(slot) as 1 | 2 | 3), note: note.trim(), links: link.trim() ? [link.trim()] : [],
    performedAt: new Date(`${day}T12:00:00Z`) > new Date() ? new Date().toISOString() : new Date(`${day}T12:00:00Z`).toISOString(),
  }), "Action recorded").then(() => { setNote(""); setLink("") })
  return (
    <form className="grid gap-3" onSubmit={e => { e.preventDefault(); void submit() }}>
      <p className="text-sm text-muted-foreground">What the agency changed. The note and link are shown on the client's record.</p>
      <div className="grid gap-3 sm:grid-cols-[12rem_10rem_1fr]">
        <Select value={slot} onValueChange={setSlot}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All facts</SelectItem>
            {record.slots.map(s => <SelectItem key={s.slot} value={String(s.slot)}>Fact {s.slot}: {s.item.fact.predicate}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" aria-label="Date of the change" value={day} max={new Date().toISOString().slice(0, 10)} onChange={e => setDay(e.target.value)} />
        <Input placeholder="Agency updated /rooms with breakfast details." aria-label="Action note" value={note} onChange={e => setNote(e.target.value)} maxLength={500} />
      </div>
      <Input type="url" placeholder="Link to the changed page (optional)" aria-label="Changed page link" value={link} onChange={e => setLink(e.target.value)} maxLength={2000} />
      <div><Button type="submit" variant="outline" disabled={busy || !note.trim()}>Record action</Button></div>
    </form>
  )
}

function Share({ record, reload }: { record: OperatorRecord; reload: () => Promise<void> }) {
  const { busy, run } = useAction(reload)
  const id = record.profile.businessId
  if (!record.share) return <Button onClick={() => void run(() => Records.share(id), "Share link created")} disabled={busy}>Create share link</Button>
  const href = `${window.location.origin}${publicRecordPath(record.share.publicId)}`
  return (
    <div className="space-y-2">
      <Input readOnly value={href} aria-label="Public record URL" onFocus={e => e.target.select()} />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void navigator.clipboard.writeText(href).then(() => toast.success("Link copied"))}>Copy link</Button>
        <Button variant="outline" asChild><a href={href} target="_blank" rel="noreferrer">Open</a></Button>
        <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm("Revoke this link? It stops working immediately and cannot be re-enabled.")) void run(() => Records.revoke(id), "Link revoked") }}>Revoke link</Button>
      </div>
      <p className="text-xs text-muted-foreground">Anyone with the link can read the reviewed record. Unreviewed answers and internal notes are never shown.</p>
    </div>
  )
}

function Section({ title, children, description }: { title: string; description?: string; children: React.ReactNode }) {
  return <section className="space-y-4 rounded-xl border p-5"><div><h2 className="font-semibold">{title}</h2>{description ? <p className="text-sm text-muted-foreground">{description}</p> : null}</div>{children}</section>
}

export function ClientRecordPage() {
  const { id = "" } = useParams()
  const [poll, setPoll] = useState(false)
  const res = useApi<RecordResponse>(`record:${id}`, async () => {
    const r = await Records.get(id)
    setPoll(r.record.activeRun)
    return r
  }, { pollMs: poll ? 3000 : null })
  const reload = async () => { await res.reload() }
  const { busy, run } = useAction(reload)
  if (res.loading && !res.data) return <Skeleton className="h-64 rounded-xl" />
  if (!res.data) return <p role="alert">{failure(res.error)}</p>
  const { record, surface } = res.data
  const initial = [...record.runs].reverse().find(r => r.kind === "INITIAL")
  const latest = record.runs.at(-1)
  const hasFollowUp = record.runs.some(r => r.kind === "FOLLOW_UP")
  return (
    <div className="space-y-6">
      <PageHeader title={record.profile.name} description={<Identity record={record} reload={reload} />} />

      <Section title="Checks" description={`Live surface: ${surface.provider === "gemini" ? "Gemini API with Google Search grounding" : surface.provider} (${surface.model}). One question per approved fact. Re-checks are started by you; nothing runs on a schedule.`}>
        <div className="flex flex-wrap gap-2">
          {!initial ? <Button disabled={busy || record.activeRun} onClick={() => void run(() => Records.run(id, "INITIAL"), "First check started")}>Run first check</Button> : <>
            <Button disabled={busy || record.activeRun} onClick={() => void run(() => Records.run(id, "FOLLOW_UP"), "Weekly re-check started")}>Run weekly re-check</Button>
            {!hasFollowUp ? <Button variant="outline" disabled={busy || record.activeRun} onClick={() => void run(() => Records.run(id, "INITIAL"), "First check started again")}>Redo first check</Button> : null}
          </>}
        </div>
        {record.runs.length ? (
          <ul className="space-y-1 text-sm">
            {[...record.runs].reverse().map(r => (
              <li key={r.id}>{r.kind === "INITIAL" ? "First check" : "Weekly re-check"} · {formatDateTime(r.createdAt)} · <strong>{RUN_STATUS_LABELS[r.status]}</strong>
                {r.status === "PARTIALLY_SUCCEEDED" || r.status === "FAILED" ? ` · ${r.checks.filter(c => c.status === "FAILED").length} of ${r.checks.length} checks failed` : ""}</li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No checks yet.</p>}
      </Section>

      {([1, 2, 3] as const).map(slot => {
        const s = record.slots.find(x => x.slot === slot)
        const latestCheck = checkFor(record, latest?.id, slot)
        const baseline = checkFor(record, initial?.id, slot)
        return (
          <Section key={slot} title={`Fact ${slot}${s ? `: ${s.item.fact.predicate}` : ""}`}>
            <SlotEditor key={s?.item.id ?? "new"} clientId={id} clientName={record.profile.name} slot={slot} current={s} reload={reload} />
            {latestCheck ? <div className="space-y-2 border-t pt-4">
              <p className="text-sm font-medium">{latest?.kind === "FOLLOW_UP" ? "Weekly re-check answer" : "First check answer"} · “{s?.history.find(h => h.id === latestCheck.itemId)?.question.prompt}”</p>
              <Review clientId={id} check={latestCheck} reload={reload} />
            </div> : null}
            {latest?.kind === "FOLLOW_UP" && baseline && baseline.id !== latestCheck?.id ? (
              <details className="text-sm"><summary className="cursor-pointer">First check answer (before)</summary><div className="pt-3"><Review clientId={id} check={baseline} reload={reload} /></div></details>
            ) : null}
            {s?.comparison ? (
              <div className="rounded-md border-l-4 bg-muted/40 px-4 py-3 text-sm">
                {s.comparison.state === "DERIVED" ? <><p className="font-semibold">{OUTCOME_LABELS[s.comparison.outcome]}</p><p>{s.comparison.text}</p></>
                  : s.comparison.state === "AWAITING_REVIEW" ? <p>Review both the first check and the re-check to derive the outcome.</p> : <p>Re-check in progress.</p>}
              </div>
            ) : null}
            {s?.actions.length ? <ul className="text-sm text-muted-foreground">{s.actions.map(a => <li key={a.id}>{formatDate(a.performedAt)}: {a.note}{a.slot === null ? " (all facts)" : ""}</li>)}</ul> : null}
          </Section>
        )
      })}

      <Section title="Agency action"><ActionForm record={record} reload={reload} /></Section>
      <Section title="Share with the client" description={record.disclosure}><Share record={record} reload={reload} /></Section>
    </div>
  )
}

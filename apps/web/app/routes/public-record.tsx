// The client-facing record at /open/:publicId. Read-only evidence, meant to
// be forwarded by an agency to its client: no navigation, account controls,
// charts or scores. Raw answers stay attached; UNKNOWN and INDETERMINATE are
// shown with their reasons; the causality disclosure is never hidden.
import { useEffect, useState } from "react"
import { useParams } from "react-router"
import { DECISION_LABELS, fetchPublicRecord, OUTCOME_LABELS, type PublicAction, type PublicAnswer, type PublicFact, type PublicRecord } from "@/lib/record"
import { cn } from "@/lib/utils"

const date = (iso: string | null) =>
  iso === null ? "—" : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(iso))

const tone = { MATCHES: "text-emerald-700 dark:text-emerald-400", CONTRADICTS: "text-red-700 dark:text-red-400", UNKNOWN: "text-amber-700 dark:text-amber-400" } as const
const outcomeTone = { OBSERVED_CORRECTION: "border-emerald-600", NO_OBSERVED_CHANGE: "border-zinc-400", INDETERMINATE: "border-amber-500" } as const

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  // A record URL is a capability: never send it to cited sites.
  return <a className="break-all underline underline-offset-2" href={href} target="_blank" rel="noreferrer noopener">{children}</a>
}

function Judgment({ answer }: { answer: PublicAnswer }) {
  if (answer.status === "CHECK_FAILED") return <p className="font-medium text-amber-700 dark:text-amber-400">Check could not be completed</p>
  return (
    <p>
      <span className={cn("font-semibold", tone[answer.judgment.decision])}>{DECISION_LABELS[answer.judgment.decision].toUpperCase()}</span>
      <span className="text-muted-foreground"> · {answer.judgment.label} · {answer.judgment.reviewedBy} · {date(answer.judgment.reviewedAt)}</span>
    </p>
  )
}

export function AnswerEvidence({ answer }: { answer: PublicAnswer }) {
  if (answer.status === "CHECK_FAILED") return <p className="text-sm">{answer.explanation}</p>
  return (
    <div className="space-y-3 text-sm">
      <figure>
        <figcaption className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">AI answer, exactly as recorded</figcaption>
        <blockquote className="whitespace-pre-wrap rounded-md border-l-4 bg-muted/50 px-4 py-3 text-base">{answer.answer}</blockquote>
      </figure>
      {answer.syntheticFixture ? <p className="font-medium text-amber-700">This answer is test data, not a live AI answer.</p> : null}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">AI surface</dt><dd>{answer.surface}{answer.model ? ` (${answer.model})` : ""}</dd>
        <dt className="text-muted-foreground">Live web retrieval</dt>
        <dd>{answer.retrieval.observed ? `Used${answer.retrieval.tool ? ` (${answer.retrieval.tool})` : ""}` : answer.retrieval.requested ? "Requested, but this answer did not use it" : "Not used"}</dd>
        <dt className="text-muted-foreground">Checked</dt><dd>{date(answer.checkedAt)}</dd>
        <dt className="text-muted-foreground">Evidence digest</dt><dd className="break-all font-mono text-xs">sha256:{answer.evidenceDigest}</dd>
      </dl>
      <div>
        <p className="text-muted-foreground">Sources the AI cited</p>
        {answer.citations.length === 0 ? <p>None returned.</p> : (
          <ol className="list-decimal pl-5">
            {answer.citations.map((c, i) => <li key={i}>{c.url ? <ExternalLink href={c.url}>{c.title ?? c.url}</ExternalLink> : c.title}</li>)}
          </ol>
        )}
      </div>
    </div>
  )
}

function Actions({ actions, title }: { actions: PublicAction[]; title: string }) {
  if (actions.length === 0) return null
  return (
    <div className="space-y-1 text-sm">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{title}</p>
      {actions.map((a, i) => (
        <p key={i}>{date(a.performedAt)}: {a.note}{a.links.map(l => <span key={l}> · <ExternalLink href={l}>{l}</ExternalLink></span>)}</p>
      ))}
    </div>
  )
}

function Step({ label, answer }: { label: string; answer: PublicAnswer | null }) {
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}{answer?.checkedAt ? ` · ${date(answer.checkedAt)}` : ""}</p>
      {answer === null ? <p className="text-sm">No reviewed earlier answer.</p> : <>
        <Judgment answer={answer} />
        <details><summary className="cursor-pointer text-sm underline underline-offset-2">Show this answer and its sources</summary><div className="pt-3"><AnswerEvidence answer={answer} /></div></details>
      </>}
    </div>
  )
}

function FactRecord({ fact }: { fact: PublicFact }) {
  const c = fact.comparison
  return (
    <article className="space-y-4 rounded-xl border p-5">
      <header className="space-y-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">Approved fact {fact.position}</p>
        <h2 className="text-lg font-semibold">{fact.fact.label}: {fact.fact.value}</h2>
        {fact.fact.source ? <p className="text-sm">Source: <ExternalLink href={fact.fact.source}>{fact.fact.source}</ExternalLink></p> : null}
      </header>
      <p className="text-sm"><span className="text-muted-foreground">Question asked: </span>“{fact.question}”</p>
      {c === null ? (
        fact.latest === null ? <p className="text-sm text-muted-foreground">Not checked yet.</p> : <Step label="Latest check" answer={fact.latest} />
      ) : (
        <section className="space-y-4" aria-label="Weekly comparison">
          <Step label="Before" answer={c.before} />
          <Actions actions={c.actions} title="Agency action" />
          <Step label="After" answer={c.after} />
          <div className={cn("rounded-md border-l-4 bg-muted/40 px-4 py-3", outcomeTone[c.outcome])}>
            <p className="font-semibold">{OUTCOME_LABELS[c.outcome]}</p>
            <p className="text-sm">{c.explanation}</p>
          </div>
        </section>
      )}
      <Actions actions={fact.pendingActions} title="Agency action recorded since the last check" />
    </article>
  )
}

export function PublicRecordView({ record }: { record: PublicRecord }) {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-5 py-10">
      {record.fixture ? <p role="note" className="rounded-md border border-amber-500 px-4 py-2 text-sm font-medium">Test fixture — not a real business record.</p> : null}
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">Checked by {record.checkedBy}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{record.client.name}</h1>
        {record.client.website ? <p className="text-sm"><ExternalLink href={record.client.website}>{record.client.website}</ExternalLink></p> : null}
        <p className="text-sm text-muted-foreground">
          Last checked {date(record.lastCheckedAt)}
          {record.surface ? ` · Observed AI surface: ${record.surface.name}${record.surface.model ? ` (${record.surface.model})` : ""}${record.surface.retrievalTool ? ` with ${record.surface.retrievalTool}` : ""}` : ""}
        </p>
      </header>
      <p role="note" className="rounded-md border px-4 py-3 text-sm font-medium">{record.disclosure}</p>
      {record.facts.length === 0 ? <p>No approved facts have been checked yet.</p> : record.facts.map(f => <FactRecord key={f.position} fact={f} />)}
      <footer className="border-t pt-4 text-xs text-muted-foreground">
        Each answer is shown exactly as the AI surface returned it, with the sources it cited. Judgments were made by a person, not software.
        An answer describes what this AI surface said when it was checked; other people may see different answers.
      </footer>
    </main>
  )
}

export function PublicRecordPage() {
  const { publicId = "" } = useParams()
  const [state, setState] = useState<{ record: PublicRecord | null; error: string | null; loading: boolean }>({ record: null, error: null, loading: true })
  useEffect(() => {
    // Keep the capability URL out of search engines and Referer headers.
    const metas = [["robots", "noindex, nofollow"], ["referrer", "no-referrer"]].map(([name, content]) => {
      const m = document.createElement("meta"); m.name = name!; m.content = content!; document.head.appendChild(m); return m
    })
    return () => metas.forEach(m => m.remove())
  }, [])
  useEffect(() => {
    let live = true
    fetchPublicRecord(publicId).then(
      record => { if (live) setState({ record, error: null, loading: false }) },
      () => { if (live) setState({ record: null, error: "This record is temporarily unavailable.", loading: false }) },
    )
    return () => { live = false }
  }, [publicId])
  useEffect(() => { if (state.record) document.title = `${state.record.client.name} — OpenRecord` }, [state.record])
  if (state.loading) return <main className="mx-auto max-w-3xl px-5 py-10 text-sm text-muted-foreground">Loading record…</main>
  if (state.error) return <main className="mx-auto max-w-3xl px-5 py-10">{state.error}</main>
  if (!state.record) return <main className="mx-auto max-w-3xl px-5 py-10"><h1 className="text-xl font-semibold">Record not available</h1><p className="text-sm text-muted-foreground">This link is not active.</p></main>
  return <PublicRecordView record={state.record} />
}

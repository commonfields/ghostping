// One client's record, operated by the agency: identity, three approved
// facts with one question each, checks on the live surface, human review,
// agency actions, the weekly re-check and its outcome, and the share URL.
import { useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import {
  CheckIcon,
  CircleDashedIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LinkIcon,
  LoaderCircleIcon,
  PenLineIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader, Panel, PanelHeader, domainOf } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { SearchSuggestions } from "@/components/search-suggestions"
import { errorMessage, formatDate, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { ApiError } from "@/lib/api"
import {
  DECISION_LABELS, OUTCOME_LABELS, publicRecordPath, Records, RUN_STATUS_LABELS, safeRecordUrl,
  type Decision, type OperatorRecord, type RecordCheck, type RecordResponse, type ValueType,
} from "@/lib/record"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

const REFUSALS: Record<string, string> = {
  NoApprovedFacts: "Approve at least one fact before running a check.",
  FactNotCurrentlyValid: "An approved fact is not currently valid. Save and approve its current version before checking.",
  InvalidFactValidity: "The end of a fact's validity must follow its start.",
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

const decisionTone: Record<Decision, string> = {
  MATCHES: "border-supported/50 bg-supported-soft text-supported",
  CONTRADICTS: "border-wrong/50 bg-wrong-soft text-wrong",
  UNKNOWN: "border-unknown/50 bg-unknown-soft text-unknown",
}
const decisionVariant: Record<Decision, "supported" | "wrong" | "unknown"> = { MATCHES: "supported", CONTRADICTS: "wrong", UNKNOWN: "unknown" }

function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    try {
      await fn()
      await reload()
      if (success) toast.success(success)
      return true
    } catch (e) {
      toast.error(failure(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

function EditClientDialog({ record, reload, open, onOpenChange }: { record: OperatorRecord; reload: () => Promise<void>; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState(record.profile.name)
  const [website, setWebsite] = useState(record.profile.websiteUrl)
  const { busy, run } = useAction(reload)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit client</DialogTitle>
          <DialogDescription>The name and website appear on the shared record.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => Records.update(record.profile.businessId, { name: name.trim(), websiteUrl: website.trim() }), "Client updated").then((saved) => {
              if (saved) onOpenChange(false)
            })
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="name">Client name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="site">Website</Label>
            <Input id="site" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SlotEditor({ clientId, clientName, slot, current, reload, onDone }: {
  clientId: string; clientName: string; slot: 1 | 2 | 3; current: OperatorRecord["slots"][number] | undefined; reload: () => Promise<void>; onDone?: () => void
}) {
  const item = current?.item
  const [label, setLabel] = useState(item?.fact.predicate ?? "")
  const [value, setValue] = useState(item?.fact.valueText ?? "")
  const [valueType, setValueType] = useState<ValueType>(item?.fact.valueType ?? "TEXT")
  const [source, setSource] = useState(item?.sourceUrl ?? "https://")
  const [question, setQuestion] = useState(item?.question.prompt ?? "")
  const { busy, run } = useAction(reload)
  const dirty = !item || label !== item.fact.predicate || value !== item.fact.valueText || valueType !== item.fact.valueType || source !== item.sourceUrl || question !== item.question.prompt
  const save = () =>
    run(
      () =>
        Records.saveSlot(clientId, slot, {
          subject: item?.fact.subject ?? clientName, predicate: label.trim(), valueText: value.trim(), valueType, sourceUrl: source.trim(), question: question.trim(),
          ...(item ? { validFrom: item.fact.validFrom, validUntil: item.fact.validUntil } : {}),
        }),
      "Saved. Approve this version before it is checked.",
    ).then((saved) => {
      if (saved) onDone?.()
    })
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
        <div className="grid gap-1.5"><Label htmlFor={`label-${slot}`} className="text-xs">Fact</Label><Input id={`label-${slot}`} placeholder="Check-in time" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} /></div>
        <div className="grid gap-1.5"><Label htmlFor={`value-${slot}`} className="text-xs">Approved value</Label><Input id={`value-${slot}`} placeholder="3:00 PM" value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} /></div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Type</Label>
          <Select value={valueType} onValueChange={(v) => setValueType(v as ValueType)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{(["TEXT", "BOOLEAN", "NUMBER", "CURRENCY", "DATE", "URL", "ENUM"] as const).map((t) => <SelectItem key={t} value={t}>{sentenceCase(t)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-1.5"><Label htmlFor={`source-${slot}`} className="text-xs">Source URL (where this fact is published)</Label><Input id={`source-${slot}`} type="url" value={source} onChange={(e) => setSource(e.target.value)} maxLength={2000} /></div>
      <div className="grid gap-1.5"><Label htmlFor={`question-${slot}`} className="text-xs">Question a buyer would ask</Label><Input id={`question-${slot}`} placeholder={`What time is check-in at ${clientName}?`} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} /></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !dirty || !label.trim() || !value.trim() || !question.trim()}>
          {busy ? <Spinner /> : null}
          {item ? "Save new version" : "Save fact"}
        </Button>
        {onDone && item ? (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        {item && (current?.history.length ?? 0) > 1 ? (
          <span className="text-[11px] text-muted-foreground">
            Version {current!.history.length}. Earlier checks keep the question and fact they used; a changed question or fact makes the next comparison indeterminate.
          </span>
        ) : null}
      </div>
    </form>
  )
}

function Review({ clientId, check, reload }: { clientId: string; check: RecordCheck; reload: () => Promise<void> }) {
  const [note, setNote] = useState("")
  const { busy, run } = useAction(reload)
  if (check.status === "QUEUED" || check.status === "RUNNING")
    return (
      <p className="flex items-center gap-2 text-xs text-review">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        Check {check.status.toLowerCase()}…
      </p>
    )
  if (check.status === "FAILED" || !check.observation) {
    return (
      <p className="flex items-start gap-2 rounded-md bg-partial-soft px-3 py-2 text-xs text-partial">
        <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Check failed: {FAILURES[check.failureClass ?? ""] ?? check.failureDetailSafe ?? check.failureClass}. It shows as “could not be completed”; run a new check to try again.
        </span>
      </p>
    )
  }
  const o = check.observation
  return (
    <div className="space-y-3">
      <blockquote className="rounded-lg bg-muted/40 px-4 py-3 text-xs leading-relaxed whitespace-pre-wrap">{o.answerText}</blockquote>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span>{check.surface}</span>·<span>{o.modelVersion ?? o.observedModel ?? o.requestedModel ?? "model unknown"}</span>·<span>{formatDateTime(o.collectedAt)}</span>·
        {check.retrievalObserved ? (
          <span className="text-supported">live web retrieval used</span>
        ) : (
          <strong className="font-medium text-partial">{check.retrievalRequested ? "retrieval requested but not used" : "no live web retrieval"}</strong>
        )}
        {o.synthetic ? <strong className="font-medium text-partial">· synthetic fixture</strong> : null}
      </p>
      {o.citations.length ? (
        <ol className="list-decimal space-y-0.5 pl-5 text-xs">
          {o.citations.map((c, i) => {
            const url = safeRecordUrl(c.uri)
            return <li key={i}>{url ? <a className="break-all text-primary hover:underline" href={url} target="_blank" rel="noreferrer">{c.title ?? url}</a> : c.title}</li>
          })}
        </ol>
      ) : (
        <p className="text-xs text-muted-foreground">No sources cited.</p>
      )}
      <SearchSuggestions html={o.provider === "gemini" && o.providerMetadata !== null && typeof o.providerMetadata === "object" && "searchSuggestionsHtml" in o.providerMetadata && typeof o.providerMetadata.searchSuggestionsHtml === "string" ? o.providerMetadata.searchSuggestionsHtml : null} />
      <div className="space-y-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {check.judgment ? (
            <>
              <span className="text-muted-foreground">Your judgment</span>
              <Badge variant={decisionVariant[check.judgment.decision]}>{DECISION_LABELS[check.judgment.decision]}</Badge>
              <span className="text-muted-foreground">
                {formatDateTime(check.judgment.reviewedAt)}
                {check.judgments.length > 1 ? ` · corrected ${check.judgments.length - 1}×, history kept` : ""}
              </span>
            </>
          ) : (
            <span className="font-medium text-review">Needs your review. It stays private until you judge it.</span>
          )}
        </div>
        <Textarea placeholder="Internal note (never shown to the client)" className="text-xs" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
        <div className="flex flex-wrap gap-1.5">
          {(["MATCHES", "CONTRADICTS", "UNKNOWN"] as Decision[]).map((d) => (
            <button
              key={d}
              type="button"
              disabled={busy}
              onClick={() => void run(() => Records.judge(clientId, o.id, d, note.trim() || null), `Marked ${DECISION_LABELS[d].toLowerCase()}`).then((saved) => { if (saved) setNote("") })}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors hover:bg-muted/60 disabled:opacity-50",
                check.judgment?.decision === d && decisionTone[d],
              )}
            >
              {check.judgment?.decision === d ? <CheckIcon className="size-3.5" /> : null}
              {DECISION_LABELS[d]}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function checkFor(record: OperatorRecord, runId: string | undefined, slot: number) {
  const run = record.runs.find((r) => r.id === runId)
  const versions = new Set(record.slots.find((s) => s.slot === slot)?.history.map((h) => h.id) ?? [])
  return run?.checks.find((c) => versions.has(c.itemId)) ?? null
}

function ActionForm({ record, reload }: { record: OperatorRecord; reload: () => Promise<void> }) {
  const [slot, setSlot] = useState("all")
  const [note, setNote] = useState("")
  const [link, setLink] = useState("")
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10))
  const { busy, run } = useAction(reload)
  const submit = () =>
    run(
      () =>
        Records.action(record.profile.businessId, {
          slot: slot === "all" ? null : (Number(slot) as 1 | 2 | 3), note: note.trim(), links: link.trim() ? [link.trim()] : [],
          performedAt: new Date(`${day}T12:00:00Z`) > new Date() ? new Date().toISOString() : new Date(`${day}T12:00:00Z`).toISOString(),
        }),
      "Action recorded",
    ).then((saved) => { if (saved) { setNote(""); setLink("") } })
  return (
    <form className="grid gap-2.5" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <div className="grid grid-cols-[minmax(0,1fr)_8.5rem] gap-2">
        <Select value={slot} onValueChange={setSlot}>
          <SelectTrigger className="w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All facts</SelectItem>
            {record.slots.map((s) => <SelectItem key={s.slot} value={String(s.slot)}>Fact {s.slot}: {s.item.fact.predicate}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" aria-label="Date of the change" required value={day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDay(e.target.value)} className="text-xs" />
      </div>
      <Textarea placeholder="Agency updated /rooms with breakfast details." aria-label="Action note" rows={2} className="text-xs" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      <Input type="url" placeholder="Link to the changed page (optional)" aria-label="Changed page link" className="text-xs" value={link} onChange={(e) => setLink(e.target.value)} maxLength={2000} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">The note and link are shown on the client&apos;s record.</span>
        <Button type="submit" size="sm" variant="outline" disabled={busy || !note.trim() || !day}>
          {busy ? <Spinner /> : null}
          Record action
        </Button>
      </div>
    </form>
  )
}

function Share({ record, reload }: { record: OperatorRecord; reload: () => Promise<void> }) {
  const { busy, run } = useAction(reload)
  const id = record.profile.businessId
  if (!record.share)
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{record.disclosure}</p>
        <Button size="sm" onClick={() => void run(() => Records.share(id), "Share link created")} disabled={busy}>
          {busy ? <Spinner /> : <LinkIcon />}
          Create share link
        </Button>
      </div>
    )
  const href = `${window.location.origin}${publicRecordPath(record.share.publicId)}`
  return (
    <div className="space-y-2.5">
      <div className="flex gap-1.5">
        <Input readOnly value={href} aria-label="Public record URL" className="text-xs" onFocus={(e) => e.target.select()} />
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Copy link"
          onClick={() => void navigator.clipboard.writeText(href).then(() => toast.success("Link copied"), () => toast.error("Could not copy the link. Select and copy the URL above."))}
        >
          <CopyIcon />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" asChild>
          <a href={href} target="_blank" rel="noreferrer">
            <ExternalLinkIcon />
            Open
          </a>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => { if (window.confirm("Revoke this link? It stops working immediately and cannot be re-enabled.")) void run(() => Records.revoke(id), "Link revoked") }}
        >
          Revoke link
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">Anyone with the link can read the reviewed record. Unreviewed answers and internal notes are never shown.</p>
    </div>
  )
}

type StepState = "done" | "current" | "todo"

function Steps({ steps }: { steps: Array<{ label: string; hint: string; state: StepState }> }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {steps.map((s, i) => (
        <li
          key={s.label}
          className={cn(
            "relative flex items-start gap-2.5 rounded-lg px-3 py-2.5",
            s.state === "current" ? "bg-card shadow-(--card-shadow)" : "",
          )}
        >
          <span
            className={cn(
              "mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold shadow-(--badge-shadow) [&_svg]:size-3",
              s.state === "done" ? "bg-supported-soft text-supported" : s.state === "current" ? "bg-review text-white" : "bg-muted text-muted-foreground shadow-none",
            )}
          >
            {s.state === "done" ? <CheckIcon strokeWidth={3} /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className={cn("block text-xs font-medium", s.state === "todo" && "text-muted-foreground")}>{s.label}</span>
            <span className="block text-[11px] leading-snug text-muted-foreground">{s.hint}</span>
          </span>
        </li>
      ))}
    </ol>
  )
}

function FactCard({ id, record, slot, latest, initial, reload }: {
  id: string; record: OperatorRecord; slot: 1 | 2 | 3; latest: OperatorRecord["runs"][number] | undefined; initial: OperatorRecord["runs"][number] | undefined; reload: () => Promise<void>
}) {
  const s = record.slots.find((x) => x.slot === slot)
  const [editing, setEditing] = useState(!s)
  const { busy, run } = useAction(reload)
  const latestCheck = checkFor(record, latest?.id, slot)
  const baseline = checkFor(record, initial?.id, slot)
  const item = s?.item

  return (
    <Panel>
      <PanelHeader
        title={
          <span className="flex items-center gap-2">
            <span className="text-muted-foreground">Fact {slot}</span>
            {item ? <span>{item.fact.predicate}</span> : <span className="text-muted-foreground">Not set</span>}
          </span>
        }
        description={item ? `“${item.question.prompt}”` : "Add a fact the client stands behind and the question a buyer would ask about it."}
      >
        {item ? (
          item.approval ? (
            <Badge variant="supported">
              <ShieldCheckIcon />
              Approved {formatDate(item.approval.approvedAt)}
            </Badge>
          ) : (
            <Badge variant="partial">Not approved</Badge>
          )
        ) : null}
        {item && !editing ? (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(true)}>
            <PenLineIcon />
            Edit
          </Button>
        ) : null}
      </PanelHeader>

      <div className="space-y-4 p-4 pt-3">
        {editing ? (
          <SlotEditor key={item?.id ?? "new"} clientId={id} clientName={record.profile.name} slot={slot} current={s} reload={reload} {...(item ? { onDone: () => setEditing(false) } : {})} />
        ) : item ? (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <div className="rounded-lg bg-muted/40 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">Approved value</div>
              <div className="text-xs font-semibold">{item.fact.valueText}</div>
              <div className="text-[11px] text-muted-foreground">
                {sentenceCase(item.fact.valueType)} · v{item.fact.version}
              </div>
            </div>
            <div className="rounded-lg bg-muted/40 px-3 py-2.5">
              <div className="text-[11px] text-muted-foreground">Published at</div>
              <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 truncate text-xs font-medium hover:underline">
                <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.sourceUrl}</span>
              </a>
            </div>
          </div>
        ) : null}

        {item && !item.approval && !editing ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-partial/25 bg-partial-soft/60 px-3 py-2">
            <span className="min-w-0 flex-1 text-xs">Not approved: it will not be checked or shown to the client.</span>
            <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void run(() => Records.approve(id, item.id), "Fact approved")}>
              {busy ? <Spinner /> : <ShieldCheckIcon />}
              Approve fact
            </Button>
          </div>
        ) : null}

        {latestCheck ? (
          <div className="space-y-2 border-t pt-4">
            <p className="text-xs font-medium">{latest?.kind === "FOLLOW_UP" ? "Weekly re-check answer" : "First check answer"}</p>
            <Review clientId={id} check={latestCheck} reload={reload} />
          </div>
        ) : null}

        {latest?.kind === "FOLLOW_UP" && baseline && baseline.id !== latestCheck?.id ? (
          <details className="group rounded-lg border px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium text-muted-foreground group-open:text-foreground">First check answer (before)</summary>
            <div className="pt-3">
              <Review clientId={id} check={baseline} reload={reload} />
            </div>
          </details>
        ) : null}

        {s?.comparison ? (
          <div
            className={cn(
              "rounded-lg px-4 py-3 text-xs",
              s.comparison.state === "DERIVED" && s.comparison.outcome === "OBSERVED_CORRECTION" ? "bg-supported-soft" : "bg-muted/50",
            )}
          >
            {s.comparison.state === "DERIVED" ? (
              <>
                <p className="text-xs font-semibold">{OUTCOME_LABELS[s.comparison.outcome]}</p>
                <p className="mt-0.5 text-muted-foreground">{s.comparison.text}</p>
              </>
            ) : s.comparison.state === "AWAITING_REVIEW" ? (
              <p>Review both the first check and the re-check to derive the outcome.</p>
            ) : (
              <p>Re-check in progress.</p>
            )}
          </div>
        ) : null}

        {s?.actions.length ? (
          <ul className="space-y-1 border-t pt-3 text-xs">
            {s.actions.map((a) => (
              <li key={a.id} className="flex gap-2">
                <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{formatDate(a.performedAt)}</span>
                <span>
                  {a.note}
                  {a.slot === null ? <span className="text-muted-foreground"> (all facts)</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  )
}

export function ClientRecordPage() {
  const { id = "" } = useParams()
  const [poll, setPoll] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const res = useApi<RecordResponse>(`record:${id}`, async () => {
    const r = await Records.get(id)
    setPoll(r.record.activeRun)
    return r
  }, { pollMs: poll ? 3000 : null })
  const reload = async () => { await res.reload() }
  const { busy, run } = useAction(reload)
  if (res.loading && !res.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-14 w-72" />
        <Skeleton className="h-20 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }
  if (!res.data) {
    return (
      <EmptyState
        icon={<TriangleAlertIcon />}
        title="Client record could not load"
        description={failure(res.error)}
        action={<Button asChild variant="outline" size="sm"><Link to="/clients">All clients</Link></Button>}
      />
    )
  }
  const { record, surface } = res.data
  const initial = [...record.runs].reverse().find((r) => r.kind === "INITIAL")
  const latest = record.runs.at(-1)
  const hasFollowUp = record.runs.some((r) => r.kind === "FOLLOW_UP")
  const approved = record.slots.filter((s) => s.item.approval).length
  const checks = latest?.checks ?? []
  const unreviewed = checks.filter((c) => c.observation && !c.judgment).length
  const reviewedFirst = initial ? initial.checks.every((c) => !c.observation || c.judgment) : false

  const stepStates: StepState[] = []
  const done = [approved >= 1, !!initial, !!initial && reviewedFirst, record.actions.length > 0, hasFollowUp, !!record.share && record.share.status === "ACTIVE"]
  let currentSet = false
  for (const d of done) {
    if (d) stepStates.push("done")
    else if (!currentSet) {
      stepStates.push("current")
      currentSet = true
    } else stepStates.push("todo")
  }
  const steps = [
    { label: "Approve facts", hint: `${approved} of 3 approved` },
    { label: "First check", hint: initial ? `${relativeTime(initial.createdAt)}` : "Ask the live AI surface" },
    { label: "Review answers", hint: unreviewed ? `${unreviewed} waiting` : initial ? "All judged" : "After the check" },
    { label: "Agency action", hint: record.actions.length ? `${record.actions.length} recorded` : "Log what you changed" },
    { label: "Weekly re-check", hint: hasFollowUp ? "Compared with first" : "Same questions again" },
    { label: "Share", hint: record.share?.status === "ACTIVE" ? "Link active" : "Send the record" },
  ].map((s, i) => ({ ...s, state: stepStates[i] ?? "todo" }))

  return (
    <div className="space-y-5 pb-4">
      <PageHeader
        back={{ to: "/clients", label: "Clients" }}
        title={record.profile.name}
        meta={
          <>
            <a className="inline-flex items-center gap-1 hover:text-foreground hover:underline" href={record.profile.websiteUrl} target="_blank" rel="noreferrer">
              <GlobeIcon className="size-3.5" />
              {domainOf(record.profile.websiteUrl)}
            </a>
            {record.profile.engagement !== "CLIENT" ? <Badge variant="outline">{record.profile.engagement === "DOGFOOD" ? "Dogfood" : "Fixture"}</Badge> : null}
            <button className="font-medium text-foreground hover:underline" onClick={() => setEditOpen(true)}>
              Edit client
            </button>
          </>
        }
        actions={
          !initial ? (
            <Button size="sm" disabled={busy || record.activeRun} onClick={() => void run(() => Records.run(id, "INITIAL"), "First check started")}>
              {record.activeRun ? <Spinner /> : <PlayIcon />}
              Run first check
            </Button>
          ) : (
            <>
              {!hasFollowUp ? (
                <Button size="sm" variant="outline" disabled={busy || record.activeRun} onClick={() => void run(() => Records.run(id, "INITIAL"), "First check started again")}>
                  Redo first check
                </Button>
              ) : null}
              <Button size="sm" disabled={busy || record.activeRun} onClick={() => void run(() => Records.run(id, "FOLLOW_UP"), "Weekly re-check started")}>
                {record.activeRun ? <Spinner /> : <RefreshCwIcon />}
                Run weekly re-check
              </Button>
            </>
          )
        }
      />

      <Steps steps={steps} />

      {record.activeRun ? (
        <div className="flex items-center gap-2 rounded-xl border border-review/20 bg-review-soft/60 px-4 py-2.5 text-xs text-review shadow-(--card-shadow)">
          <LoaderCircleIcon className="size-4 animate-spin" />
          A check is running on the live surface. This page updates on its own.
        </div>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4">
          {([1, 2, 3] as const).map((slot) => (
            <FactCard key={slot} id={id} record={record} slot={slot} latest={latest} initial={initial} reload={reload} />
          ))}
        </div>

        <div className="space-y-4 lg:sticky lg:top-0">
          <Panel>
            <PanelHeader title="Checks" description={`${surface.provider === "gemini" ? "Gemini API with Google Search grounding" : surface.provider} (${surface.model})`} />
            <div className="p-2 pt-1">
              {record.runs.length ? (
                <ul>
                  {[...record.runs].reverse().map((r) => {
                    const failed = r.checks.filter((c) => c.status === "FAILED").length
                    return (
                      <li key={r.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs">
                        {r.status === "RUNNING" || r.status === "QUEUED" ? (
                          <LoaderCircleIcon className="size-3.5 animate-spin text-review" />
                        ) : r.status === "SUCCEEDED" ? (
                          <CheckIcon className="size-3.5 text-supported" />
                        ) : r.status === "FAILED" ? (
                          <TriangleAlertIcon className="size-3.5 text-wrong" />
                        ) : (
                          <CircleDashedIcon className="size-3.5 text-partial" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{r.kind === "INITIAL" ? "First check" : "Weekly re-check"}</span>
                          <span className="block text-[11px] text-muted-foreground">
                            {RUN_STATUS_LABELS[r.status]}
                            {r.status === "PARTIALLY_SUCCEEDED" || r.status === "FAILED" ? ` · ${failed} of ${r.checks.length} checks failed` : ""}
                          </span>
                        </span>
                        <span className="text-[11px] text-muted-foreground tabular-nums" title={formatDateTime(r.createdAt)}>
                          {relativeTime(r.createdAt)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="px-2 py-3 text-xs text-muted-foreground">No checks yet. One question per approved fact; re-checks are started by you, nothing runs on a schedule.</p>
              )}
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Agency action" description="What the agency changed" />
            <div className="p-4 pt-3">
              <ActionForm record={record} reload={reload} />
            </div>
          </Panel>
          <Panel>
            <PanelHeader title="Share with the client" />
            <div className="p-4 pt-3">
              <Share record={record} reload={reload} />
            </div>
          </Panel>
        </div>
      </div>

      <EditClientDialog key={`${record.profile.name}-${record.profile.websiteUrl}`} record={record} reload={reload} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  )
}


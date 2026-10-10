import { useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { BookCheckIcon, ChevronRightIcon, ExternalLinkIcon, GlobeIcon, MessageSquareQuoteIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, Field, PageHeader, Panel, PanelHeader, domainOf, pathOf } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { ControlBadge, ProviderChip, RepresentationStateBadge } from "@/components/status"
import { Representations, Sources } from "@/lib/api"
import { errorMessage, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

export function RepresentationDetailPage() {
  const { id = "", bindingId = "" } = useParams()
  const { data, loading, error, reload } = useApi(`representation:${bindingId}`, () => Representations.get(id, bindingId))
  const [checking, setChecking] = useState(false)
  const d = data ?? null

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16" />
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }
  if (error || !d) {
    return (
      <EmptyState
        icon={<TriangleAlertIcon />}
        title="Representation not found"
        description="It may have been removed, or it belongs to a different account."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to={`/businesses/${id}/representations`}>All representations</Link>
          </Button>
        }
      />
    )
  }

  const effective = d.current?.effective_observation ?? null
  const latest = d.current?.latest_attempt ?? null
  const successful = d.current?.latest_successful_check ?? null
  const failedLatest = latest?.collection_state === "FAILED" && effective !== null
  const state = d.current?.finding.state ?? "UNKNOWN"
  const history = [...d.history].reverse()

  const checkNow = () => {
    setChecking(true)
    Sources.check(id, bindingId)
      .then((r) => {
        toast.success("Source checked", {
          description:
            r.finding.state === "IN_SYNC"
              ? "The published value matches the approved value."
              : r.finding.state === "DRIFT"
                ? "The published value differs from the approved value."
                : "The observation could not be compared.",
        })
        return reload()
      })
      .catch((err: unknown) => toast.error("Source check failed", { description: errorMessage(err) }))
      .finally(() => setChecking(false))
  }

  return (
    <div className="space-y-4 pb-4">
      <PageHeader
        back={{ to: `/businesses/${id}/representations`, label: "Representations" }}
        title={sentenceCase(d.fact.predicate)}
        meta={
          <>
            <RepresentationStateBadge state={state} />
            <a href={d.source.url} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:text-foreground hover:underline">
              <GlobeIcon className="size-3.5" />
              <span className="font-medium text-foreground">{domainOf(d.source.url)}</span>
              <span className="truncate">{pathOf(d.source.url)}</span>
            </a>
            <ControlBadge control={d.source.control} />
            {latest ? <span title={formatDateTime(latest.completed_at)}>Last checked {relativeTime(latest.completed_at)}</span> : <span>Never checked</span>}
          </>
        }
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <a href={d.source.url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon />
                Open source
              </a>
            </Button>
            <Button size="sm" disabled={checking} onClick={checkNow}>
              {checking ? <Spinner /> : <RefreshCwIcon />}
              {checking ? "Checking…" : "Check now"}
            </Button>
          </>
        }
      />

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-4">
          <Panel>
            <PanelHeader title="Current representation" description="Derived from the last successful observation. A failed check never erases it." />
            <div className="grid gap-px p-4 pt-3 md:grid-cols-2 md:gap-4">
              <div className="relative rounded-lg bg-muted/40 p-4">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <BookCheckIcon className="size-3.5" />
                  Approved value
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs font-semibold">{d.fact.valueText}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">v{d.fact.version}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {sentenceCase(d.fact.valueType)} · status {sentenceCase(d.fact.status).toLowerCase()}
                </p>
              </div>
              <div className="relative rounded-lg bg-muted/40 p-4">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <GlobeIcon className="size-3.5" />
                  Published at {domainOf(d.source.url)}
                </div>
                <div className={cn("text-xs font-semibold", state === "DRIFT" && "text-wrong", !effective && "text-muted-foreground")}>
                  {effective?.extracted_value ?? "Not observed yet"}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{d.current?.finding.reason ?? "No observation yet."}</p>
              </div>
            </div>
            {failedLatest && latest ? (
              <div className="px-4 pb-4">
                <Alert>
                  <TriangleAlertIcon />
                  <AlertTitle className="font-normal">Latest check failed</AlertTitle>
                  <AlertDescription>
                    <p>
                      {`${formatDateTime(latest.completed_at)}${latest.failure ? ` (${sentenceCase(latest.failure)})` : ""}. The state above still reflects the last good observation.`}
                    </p>
                  </AlertDescription>
                </Alert>
              </div>
            ) : null}
          </Panel>

          <Panel>
            <PanelHeader title="History" description="Every observation of this source, newest first. Value changes are marked." />
            <div className="p-4 pt-3">
              {history.length === 0 ? (
                <p className="text-xs text-muted-foreground">Not observed yet.</p>
              ) : (
                <ol>
                  {history.map((h, i) => {
                    const older = history[i + 1]
                    const changed = older !== undefined && older.extracted_value !== h.extracted_value && h.extracted_value !== null && older.extracted_value !== null
                    const failed = h.collection_state === "FAILED"
                    return (
                      <li key={h.observation_id} className="relative flex gap-3 pb-4 last:pb-0">
                        {i < history.length - 1 ? <span aria-hidden className="absolute top-4 bottom-0 left-[4.5px] w-px bg-border" /> : null}
                        <span
                          aria-hidden
                          className={cn(
                            "relative z-10 mt-1.5 size-2.5 shrink-0 rounded-full ring-2 ring-card",
                            failed ? "bg-partial" : h.state === "DRIFT" ? "bg-wrong" : h.state === "IN_SYNC" ? "bg-supported" : "bg-unknown",
                          )}
                        />
                        <div className="grid min-w-0 flex-1 gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-medium">{failed ? "Check failed" : (h.extracted_value ?? "—")}</span>
                              {changed ? <span className="rounded-full bg-review-soft px-1.5 text-[10px] font-medium text-review shadow-(--badge-shadow)">Value changed from {older?.extracted_value}</span> : null}
                            </div>
                            <p className="text-[11px] text-muted-foreground">
                              {sentenceCase(h.collection_state)} · {h.reason}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 sm:justify-end">
                            <RepresentationStateBadge state={h.state} />
                            <span className="w-28 text-right text-[11px] whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(h.completed_at)}</span>
                          </div>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </Panel>

          <Panel>
            <PanelHeader title="AI citations" description="AI answers that referenced this source" icon={<MessageSquareQuoteIcon />} />
            <div className="space-y-3 p-4 pt-3">
              {d.citations.length === 0 ? (
                <p className="text-xs text-muted-foreground">No AI answer has cited this source yet.</p>
              ) : (
                <ul className="divide-y overflow-hidden rounded-lg border">
                  {d.citations.map((c) => (
                    <li key={`${c.observation_id}-${c.uri}`}>
                      <Link to={`/observations/${c.observation_id}`} className="flex items-center gap-3 px-3 py-2.5 text-xs transition-colors hover:bg-muted/40">
                        <span className="min-w-0 flex-1">
                          <ProviderChip provider={c.provider} model={c.observed_model} />
                          {c.claim_text ? <span className="mt-0.5 block truncate text-muted-foreground">&ldquo;{c.claim_text}&rdquo;</span> : null}
                        </span>
                        <span className="text-muted-foreground tabular-nums" title={formatDateTime(c.collected_at)}>
                          {relativeTime(c.collected_at)}
                        </span>
                        <span className="flex items-center gap-0.5 font-medium">
                          Open answer
                          <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Citation shows that the source was referenced in this observation. It does not prove the source caused the answer.
              </p>
            </div>
          </Panel>
        </div>

        <div className="space-y-4 lg:sticky lg:top-0">
          <Panel>
            <PanelHeader title="Checks" />
            <dl className="grid gap-3 p-4 pt-3">
              <Field label="Last checked">
                {latest ? (
                  <>
                    {formatDateTime(latest.completed_at)} <span className="font-normal text-muted-foreground">· {sentenceCase(latest.collection_state)}</span>
                  </>
                ) : (
                  "Never"
                )}
              </Field>
              <Field label="Last successful check">
                {successful ? (
                  <>
                    {formatDateTime(successful.completed_at)} <span className="font-normal text-muted-foreground">· {sentenceCase(successful.collection_state)}</span>
                  </>
                ) : (
                  "None yet"
                )}
              </Field>
              <Field label="Value evidence observed">{effective ? formatDateTime(effective.completed_at) : "Not observed yet"}</Field>
              <Field label="Observations">{d.history.length}</Field>
            </dl>
          </Panel>
          <Panel>
            <PanelHeader title="Technical details" />
            <dl className="grid gap-3 p-4 pt-3">
              <Field label="Source URL">
                <a href={d.source.url} target="_blank" rel="noreferrer" className="break-all hover:underline">
                  {d.source.url}
                </a>
              </Field>
              <Field label="Extractor">
                <span className="font-mono text-xs">
                  {d.binding.extractorKind} {d.binding.extractorSelector}
                </span>
              </Field>
              <Field label="Comparator">
                <span className="font-mono text-xs">{d.binding.comparator}</span>
              </Field>
              <Field label="Subject">{d.fact.subject}</Field>
            </dl>
          </Panel>
        </div>
      </div>
    </div>
  )
}

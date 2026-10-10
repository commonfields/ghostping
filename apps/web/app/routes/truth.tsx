import { useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import { ArchiveIcon, BookCheckIcon, EllipsisIcon, GitBranchPlusIcon, HistoryIcon, KeyIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EmptyState, PageHeader, Panel, StatStrip, domainOf } from "@/components/page"
import { FactStatusBadge, RepresentationStateBadge } from "@/components/status"
import { VerdictBar } from "@/components/charts"
import { AnalyticsApi, Facts, Issues, Representations, type Fact, type FactProvenance, type RepresentationRow, type VerdictCounts } from "@/lib/api"
import { errorMessage, formatDate, formatDateTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { FactDialog } from "./facts"

const shortenDigest = (digest: string) => (digest.length > 16 ? `${digest.slice(0, 8)}…${digest.slice(-6)}` : digest)

export function TruthPage() {
  const { id = "" } = useParams()
  const { data, loading, reload } = useApi(`facts:${id}`, () => Facts.list(id))
  const [view, setView] = useState<"active" | "all">("active")
  const [addOpen, setAddOpen] = useState(false)
  const [superseding, setSuperseding] = useState<Fact | null>(null)
  const [retiring, setRetiring] = useState<Fact | null>(null)
  const [historyOf, setHistoryOf] = useState<Fact | null>(null)

  const facts = useMemo(() => data?.facts ?? [], [data])
  const conflicts = useMemo(() => data?.conflicts ?? [], [data])
  const authority = data?.authority?.mode ?? "HOSTED"
  const repositoryManaged = authority === "REPOSITORY_MANIFEST"
  const conflictIds = useMemo(() => new Set(conflicts.flatMap((c) => [c.a, c.b])), [conflicts])
  const activeCount = facts.filter((f) => f.status === "ACTIVE").length
  const visible = view === "active" ? facts.filter((f) => f.status === "ACTIVE") : facts
  const provenanceOf = (factId: string) => data?.provenance?.[factId] ?? null
  const issues = useApi(`issues:${id}`, () => Issues.list(id))
  const reps = useApi(`representations:${id}`, () => Representations.list(id))
  // How each fact is doing elsewhere in the product: open issues citing it and sources watching it.
  const analytics = useApi(`analytics:${id}:30`, () => AnalyticsApi.get(id, 30))
  const verdictsByFact = useMemo(() => new Map((analytics.data?.analytics.facts ?? []).map((f) => [f.id, f])), [analytics.data])
  const sourcesByFact = useMemo(() => {
    const m = new Map<string, RepresentationRow[]>()
    for (const r of reps.data?.representations ?? []) m.set(r.fact.id, [...(m.get(r.fact.id) ?? []), r])
    return m
  }, [reps.data])
  const usage = useMemo(() => {
    const m = new Map<string, { issues: number; wrong: number; sources: number; drift: number }>()
    const get = (k: string) => m.get(k) ?? { issues: 0, wrong: 0, sources: 0, drift: 0 }
    for (const i of issues.data?.issues ?? [])
      for (const f of i.facts) {
        const u = get(f.predicate)
        m.set(f.predicate, { ...u, issues: u.issues + 1, wrong: u.wrong + (i.state === "WRONG" ? 1 : 0) })
      }
    for (const r of reps.data?.representations ?? []) {
      const u = get(r.fact.predicate)
      m.set(r.fact.predicate, { ...u, sources: u.sources + 1, drift: u.drift + (r.finding.state === "DRIFT" ? 1 : 0) })
    }
    return m
  }, [issues.data, reps.data])

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Truth"
        description="The facts this business stands behind. OpenRecord compares source and AI representations against these versions."
        actions={
          repositoryManaged ? null : (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Add fact
            </Button>
          )
        }
      />

      <StatStrip
        stats={[
          { key: "active", label: "Active facts", value: loading ? <Skeleton className="h-5 w-8" /> : activeCount, hint: "Used for new reviews", tone: "supported", active: view === "active", onSelect: () => setView("active") },
          { key: "all", label: "All versions", value: loading ? <Skeleton className="h-5 w-8" /> : facts.length, hint: "Including superseded and retired", active: view === "all", onSelect: () => setView("all") },
          { key: "conflicts", label: "Conflicts", value: loading ? <Skeleton className="h-5 w-8" /> : conflicts.length, hint: conflicts.length ? "Two active facts overlap" : "No overlapping facts", tone: "wrong" },
          { key: "authority", label: "Authority", value: <span className="text-xs">{repositoryManaged ? "Managed by repository manifest" : "Managed in OpenRecord"}</span>, hint: repositoryManaged ? "Edit in the manifest, then sync" : "Edit here; every change is versioned" },
        ]}
      />


      {repositoryManaged ? (
        <Alert>
          <KeyIcon />
          <AlertTitle className="font-normal">This business&rsquo;s truth is managed by its repository manifest.</AlertTitle>
          <AlertDescription>Changes must be synchronized from that manifest. Hosted editing is disabled; the API rejects it.</AlertDescription>
        </Alert>
      ) : null}

      {conflicts.length > 0 ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>Two active facts cover the same thing</AlertTitle>
          <AlertDescription>
            <p>
              The highlighted rows are both active for the same period. OpenRecord does not pick a winner. Supersede or retire one of them so
              reviews have a single source of truth.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}


      {loading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<BookCheckIcon />}
          title={facts.length === 0 ? "No approved facts yet" : "No active facts"}
          description="Add the facts AI assistants most often get wrong, such as monthly price, supported integrations, or refund terms."
          action={
            repositoryManaged ? undefined : (
              <Button onClick={() => setAddOpen(true)}>
                <PlusIcon />
                Add fact
              </Button>
            )
          }
        />
      ) : (
        view === "active" ? (
          <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {visible.map((f) => (
              <li key={f.id}>
                <FactCard
                  businessId={id}
                  fact={f}
                  conflict={conflictIds.has(f.id)}
                  provenance={provenanceOf(f.id)}
                  verdicts={verdictsByFact.get(f.id) ?? null}
                  sources={sourcesByFact.get(f.id) ?? []}
                  repositoryManaged={repositoryManaged}
                  onHistory={() => setHistoryOf(f)}
                  onSupersede={() => setSuperseding(f)}
                  onRetire={() => setRetiring(f)}
                />
              </li>
            ))}
          </ul>
        ) : (
        <Panel>
          <div className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_7rem_7.5rem_7.5rem_minmax(0,9rem)_2rem] gap-x-4 border-b bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground lg:grid">
            <span>Fact</span>
            <span>Value</span>
            <span>Status</span>
            <span>Open issues</span>
            <span>Watched at</span>
            <span>Provenance</span>
            <span className="sr-only">Actions</span>
          </div>
          <ul className="divide-y">
            {visible.map((f) => {
              const conflict = conflictIds.has(f.id)
              const prov = provenanceOf(f.id)
              const u = usage.get(f.predicate)
              return (
                <li
                  key={f.id}
                  className={cn(
                    "grid items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-xs transition-colors hover:bg-muted/30 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_7rem_7.5rem_7.5rem_minmax(0,9rem)_2rem]",
                    conflict && "bg-wrong-soft/60 hover:bg-wrong-soft",
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{sentenceCase(f.predicate)}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {f.subject} · {sentenceCase(f.valueType)}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-semibold">{f.valueText}</span>
                    {conflict ? (
                      <Badge variant="wrong">
                        <TriangleAlertIcon />
                        Conflict
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <FactStatusBadge status={f.status} />
                    <span className="text-[11px] text-muted-foreground tabular-nums">v{f.version}</span>
                  </span>
                  <span>
                    {u?.issues ? (
                      <Link to={`/businesses/${id}/issues?view=answers&fact=${encodeURIComponent(f.predicate)}`} className="hover:underline">
                        <span className="font-medium tabular-nums">{u.issues}</span>
                        {u.wrong ? <span className="text-wrong"> · {u.wrong} wrong</span> : null}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">None</span>
                    )}
                  </span>
                  <span>
                    {u?.sources ? (
                      <Link to={`/businesses/${id}/representations`} className="hover:underline">
                        <span className="font-medium tabular-nums">
                          {u.sources} source{u.sources === 1 ? "" : "s"}
                        </span>
                        {u.drift ? <span className="text-wrong"> · {u.drift} drift</span> : null}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">Not watched</span>
                    )}
                  </span>
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {prov ? (
                      <>
                        Manifest key <span className="font-medium text-foreground">{prov.manifestKey}</span>
                      </>
                    ) : (
                      "Entered by hand"
                    )}
                  </span>
                  <span className="text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`Actions for ${sentenceCase(f.predicate)}`}>
                          <EllipsisIcon />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem onSelect={() => setHistoryOf(f)}>
                          <HistoryIcon />
                          View history
                        </DropdownMenuItem>
                        {f.status === "ACTIVE" && !repositoryManaged ? (
                          <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setSuperseding(f)}>
                              <GitBranchPlusIcon />
                              New version
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={() => setRetiring(f)}>
                              <ArchiveIcon className="text-destructive" />
                              Retire fact
                            </DropdownMenuItem>
                          </>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </span>
                </li>
              )
            })}
          </ul>
        </Panel>
        )
      )}

      <FactDialog businessId={id} open={addOpen} onOpenChange={setAddOpen} onSaved={() => void reload()} />
      <FactDialog
        businessId={id}
        fact={superseding}
        open={superseding !== null}
        onOpenChange={(o) => (o ? undefined : setSuperseding(null))}
        onSaved={() => void reload()}
      />
      <HistoryDialog businessId={id} fact={historyOf} onOpenChange={(o) => (o ? undefined : setHistoryOf(null))} />

      <AlertDialog open={retiring !== null} onOpenChange={(o) => (o ? undefined : setRetiring(null))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire this fact?</AlertDialogTitle>
            <AlertDialogDescription>
              {retiring ? `${sentenceCase(retiring.predicate)} (${retiring.valueText}) ` : ""}
              will stop being used for new reviews. Past verdicts that cite it keep their history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (!retiring) return
                Facts.retire(id, retiring.id)
                  .then(() => {
                    toast.success("Fact retired")
                    return reload()
                  })
                  .catch((err: unknown) => toast.error("Could not retire the fact", { description: errorMessage(err) }))
              }}
            >
              Retire fact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function FactCard({
  businessId,
  fact: f,
  conflict,
  provenance,
  verdicts,
  sources,
  repositoryManaged,
  onHistory,
  onSupersede,
  onRetire,
}: {
  businessId: string
  fact: Fact
  conflict: boolean
  provenance: FactProvenance
  verdicts: (VerdictCounts & { id: string }) | null
  sources: RepresentationRow[]
  repositoryManaged: boolean
  onHistory: () => void
  onSupersede: () => void
  onRetire: () => void
}) {
  const reviewed = verdicts ? verdicts.supported + verdicts.wrong + verdicts.partial + verdicts.unknown : 0
  const total = verdicts ? reviewed + verdicts.unreviewed : 0
  const drift = sources.filter((r) => r.finding.state === "DRIFT").length
  return (
    <Panel className={cn("flex h-full flex-col", conflict && "ring-1 ring-wrong/40")}>
      <div className="flex items-start gap-2 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-xs text-muted-foreground">{sentenceCase(f.predicate)}</h3>
          <p className="mt-0.5 truncate text-sm font-semibold">{f.valueText}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-mr-1.5 size-7" aria-label={`Actions for ${sentenceCase(f.predicate)}`}>
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={onHistory}>
              <HistoryIcon />
              View history
            </DropdownMenuItem>
            {!repositoryManaged ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onSupersede}>
                  <GitBranchPlusIcon />
                  New version
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onRetire}>
                  <ArchiveIcon className="text-destructive" />
                  Retire fact
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
        <FactStatusBadge status={f.status} />
        <Badge variant="outline">v{f.version}</Badge>
        <Badge variant="outline">{sentenceCase(f.valueType)}</Badge>
        {conflict ? (
          <Badge variant="wrong">
            <TriangleAlertIcon />
            Conflict
          </Badge>
        ) : null}
      </div>

      <div className="mt-3 space-y-3 border-t px-4 py-3">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-muted-foreground">In AI answers, 30 days</span>
            {total ? (
              <span className="font-medium tabular-nums">
                {reviewed ? `${Math.round(((verdicts?.supported ?? 0) / reviewed) * 100)}% accurate` : "Not reviewed yet"}
              </span>
            ) : null}
          </div>
          {verdicts && total ? (
            <>
              <VerdictBar counts={verdicts} className="h-1.5" />
              <Link to={`/businesses/${businessId}/issues?view=answers&fact=${encodeURIComponent(f.predicate)}`} className="block text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                {total} claim{total === 1 ? "" : "s"}
                {verdicts.wrong ? <span className="text-wrong"> · {verdicts.wrong} wrong</span> : null}
                {verdicts.partial ? <span className="text-partial"> · {verdicts.partial} partial</span> : null}
              </Link>
            </>
          ) : (
            <p className="text-[11px] text-muted-foreground">No reviewed claim has cited this fact yet.</p>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-baseline justify-between text-[11px]">
            <span className="text-muted-foreground">Published at</span>
            {sources.length ? (
              <Link to={`/businesses/${businessId}/representations`} className={cn("font-medium hover:underline", drift && "text-wrong")}>
                {drift ? `${drift} drift` : "In sync"}
              </Link>
            ) : null}
          </div>
          {sources.length ? (
            <ul className="space-y-0.5">
              {sources.slice(0, 3).map((r) => (
                <li key={r.binding_id}>
                  <Link to={`/businesses/${businessId}/representations/${r.binding_id}`} className="flex items-center gap-2 rounded-md text-[11px] hover:underline">
                    <span className="min-w-0 flex-1 truncate">{domainOf(r.source.url)}</span>
                    <RepresentationStateBadge state={r.finding.state} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Link to={`/businesses/${businessId}/representations/discovery`} className="text-[11px] text-muted-foreground hover:text-foreground hover:underline">
              Not watched anywhere. Find pages that publish it
            </Link>
          )}
        </div>
      </div>

      <div className="mt-auto border-t px-4 py-2 text-[11px] text-muted-foreground">
        {provenance ? (
          <>
            Manifest key <span className="font-medium text-foreground">{provenance.manifestKey}</span>
          </>
        ) : (
          <>Entered by hand · valid from {formatDate(f.validFrom)}</>
        )}
      </div>
    </Panel>
  )
}

function HistoryDialog({ businessId, fact, onOpenChange }: { businessId: string; fact: Fact | null; onOpenChange: (open: boolean) => void }) {
  const { data, loading } = useApi(fact ? `fact-history:${fact.id}` : null, () => (fact ? Facts.history(businessId, fact.id) : Promise.reject(new Error("no fact"))))
  const history = useMemo(() => data?.history ?? [], [data])
  return (
    <Dialog open={fact !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Version history{factsTitleSuffix(fact)}</DialogTitle>
          <DialogDescription>Immutable prior versions. New versions supersede; nothing is rewritten.</DialogDescription>
        </DialogHeader>
        {loading ? (
          <Skeleton className="h-32" />
        ) : (
          <ul className="space-y-3">
            {history.map((h) => (
              <li key={h.id} className="space-y-2 rounded-lg border px-4 py-3">
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <FactStatusBadge status={h.status} />
                  <span className="text-xs font-medium">{h.valueText}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">v{h.version}</span>
                  <span className="w-full text-xs text-muted-foreground">
                    {formatDate(h.validFrom)}
                    {h.validUntil ? <span> to {formatDate(h.validUntil)}</span> : null}
                  </span>
                </div>
                {h.provenance ? (
                  <div className="border-t pt-2">
                    <ManifestProvenance provenance={h.provenance} />
                  </div>
                ) : (
                  <p className="border-t pt-2 text-xs text-muted-foreground">Entered by hand — no repository provenance.</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

function factsTitleSuffix(fact: Fact | null) {
  return fact ? ` — ${fact.predicate}` : ""
}

export function ManifestProvenance({ provenance }: { provenance: { manifestKey: string; manifestDigest: string; sourceRevision: string | null; syncedAt: string; sourceUrl: string | null } }) {
  return (
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      <div>
        <dt className="text-xs text-muted-foreground">Manifest key</dt>
        <dd className="font-medium">{provenance.manifestKey}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Source URL</dt>
        <dd className="font-medium break-all">{provenance.sourceUrl ?? "Unknown"}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Source revision</dt>
        <dd className="font-medium">{provenance.sourceRevision ?? "Unknown"}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Last synchronized</dt>
        <dd className="font-medium">{formatDateTime(provenance.syncedAt)}</dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-xs text-muted-foreground">Manifest digest</dt>
        <dd>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-mono text-xs">{shortenDigest(provenance.manifestDigest)}</span>
            </TooltipTrigger>
            <TooltipContent className="font-mono text-xs break-all">{provenance.manifestDigest}</TooltipContent>
          </Tooltip>
        </dd>
      </div>
    </dl>
  )
}

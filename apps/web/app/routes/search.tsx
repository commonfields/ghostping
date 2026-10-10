import { useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import {
  CheckCheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  CodeIcon,
  FileSearchIcon,
  GlobeIcon,
  LinkIcon,
  LoaderCircleIcon,
  MapIcon,
  PlayIcon,
  PlusIcon,
  ScanSearchIcon,
  ShieldCheckIcon,
  TagIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, Field, PageHeader, Panel, PanelHeader, StatStrip, StepFlow, domainOf, pathOf, type Stat } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { Search, type SiteFinding, type SiteRun } from "@/lib/api"
import { errorMessage, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

export const findingKindLabels: Record<string, string> = {
  BLOCKED_BY_META: "Blocked from indexing",
  BLOCKED_BY_HEADER: "Blocked by response header",
  BLOCKED_BY_ROBOTS: "Blocked by robots.txt",
  NOT_FOUND: "Page not found",
  SERVER_ERROR: "Server error",
  REDIRECT_LOOP: "Redirect loop",
  REDIRECT_CHAIN_LONG: "Long redirect chain",
  BROKEN_CANONICAL: "Broken canonical tag",
  CANONICALIZED_ELSEWHERE: "Canonical points elsewhere",
  MISSING_TITLE: "Missing title",
  MISSING_DESCRIPTION: "Missing description",
  MISSING_H1: "Missing primary heading",
  BROKEN_INTERNAL_LINK: "Broken internal link",
  POSSIBLE_ORPHAN: "Possibly unreachable page",
  INVALID_STRUCTURED_DATA: "Invalid structured data",
  MISSING_ALT: "Missing image text",
  RENDER_DISCREPANCY: "Rendered page differs",
  SITEMAP_INVALID: "Sitemap cannot be read",
  SITEMAP_MISSING: "No sitemap found",
  ROBOTS_BLOCKS_IMPORTANT: "robots.txt blocks important page",
}

const findingKindLabel = (kind: string) => findingKindLabels[kind] ?? sentenceCase(kind)

// What an inspection looks at, grouped the way an operator thinks about it.
const checkGroups = [
  { icon: <ShieldCheckIcon />, title: "Indexability", kinds: ["BLOCKED_BY_META", "BLOCKED_BY_HEADER", "BLOCKED_BY_ROBOTS"] },
  { icon: <CircleXIcon />, title: "Broken pages", kinds: ["NOT_FOUND", "SERVER_ERROR", "REDIRECT_LOOP", "REDIRECT_CHAIN_LONG"] },
  { icon: <LinkIcon />, title: "Canonicals and links", kinds: ["BROKEN_CANONICAL", "CANONICALIZED_ELSEWHERE", "BROKEN_INTERNAL_LINK", "POSSIBLE_ORPHAN"] },
  { icon: <TagIcon />, title: "Page metadata", kinds: ["MISSING_TITLE", "MISSING_DESCRIPTION", "MISSING_H1", "MISSING_ALT"] },
  { icon: <CodeIcon />, title: "Structured data and rendering", kinds: ["INVALID_STRUCTURED_DATA", "RENDER_DISCREPANCY"] },
  { icon: <MapIcon />, title: "Sitemap and robots", kinds: ["SITEMAP_INVALID", "SITEMAP_MISSING", "ROBOTS_BLOCKS_IMPORTANT"] },
]

type Bucket = "open" | "approval" | "progress" | "pending" | "verified" | "all"
const bucketOf = (status: string): Exclude<Bucket, "all"> =>
  status === "AWAITING_APPROVAL"
    ? "approval"
    : status === "APPROVED" || status === "FIX_IN_PROGRESS"
      ? "progress"
      : status === "FIX_APPLIED" || status === "VERIFICATION_PENDING"
        ? "pending"
        : status === "VERIFIED_FIXED"
          ? "verified"
          : "open"

function FindingStatusBadge({ status }: { status: string }) {
  if (status === "VERIFIED_FIXED") return <Badge variant="supported"><CircleCheckIcon />Verified fixed</Badge>
  if (status === "VERIFIED_NOT_FIXED") return <Badge variant="wrong"><CircleXIcon />Still present</Badge>
  if (status === "VERIFICATION_PENDING" || status === "FIX_APPLIED") return <Badge variant="review"><ClockIcon />Verification pending</Badge>
  if (status === "AWAITING_APPROVAL") return <Badge variant="review"><ClockIcon />Awaiting approval</Badge>
  if (status === "APPROVED" || status === "FIX_IN_PROGRESS") return <Badge variant="partial"><LoaderCircleIcon />Fix in progress</Badge>
  if (status === "DISMISSED") return <Badge variant="secondary">Dismissed</Badge>
  return <Badge variant="secondary">Open</Badge>
}

function SeverityDot({ severity }: { severity: string }) {
  const s = severity.toUpperCase()
  const tone = s.includes("CRIT") || s.includes("HIGH") ? "bg-wrong" : s.includes("MED") ? "bg-partial" : "bg-muted-foreground/50"
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <span aria-hidden className={cn("size-1.5 rounded-full", tone)} />
      {sentenceCase(severity)}
    </span>
  )
}

function RunBadge({ state }: { state: SiteRun["state"] }) {
  switch (state) {
    case "QUEUED":
      return <Badge variant="secondary"><ClockIcon />Queued</Badge>
    case "RUNNING":
      return <Badge variant="review"><LoaderCircleIcon className="animate-spin" />Running</Badge>
    case "SUCCEEDED":
      return <Badge variant="supported"><CircleCheckIcon />Completed</Badge>
    case "PARTIALLY_SUCCEEDED":
      return <Badge variant="partial"><CircleAlertIcon />Partial</Badge>
    case "FAILED":
      return <Badge variant="wrong"><CircleXIcon />Failed</Badge>
  }
}

export function SearchOverviewPage() {
  const { id = "" } = useParams()
  const [addOpen, setAddOpen] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [bucket, setBucket] = useState<Bucket>("all")
  const overview = useApi(`search-overview:${id}`, () => Search.overview(id))
  const o = overview.data?.overview ?? null
  const sites = o?.sites ?? []
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null)
  const siteId = selectedSiteId ?? sites[0]?.id ?? null
  const site = sites.find((s) => s.id === siteId) ?? null

  const [polling, setPolling] = useState(false)
  const runs = useApi(
    siteId ? `site-runs:${siteId}` : null,
    async () => {
      const r = await Search.listRuns(id, siteId as string)
      setPolling(r.runs.some((x) => x.state === "QUEUED" || x.state === "RUNNING"))
      return r
    },
    { pollMs: polling ? 3000 : null },
  )
  const sortedRuns = useMemo(() => [...(runs.data?.runs ?? [])].sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1)), [runs.data])
  const latest: SiteRun | null = sortedRuns[0] ?? null
  const isActive = latest?.state === "QUEUED" || latest?.state === "RUNNING"
  const findings = useApi(siteId ? `site-findings:${siteId}:${latest?.state ?? ""}` : null, () => Search.listFindings(id, siteId as string))
  const gsc = useApi(`gsc:${id}`, () => Search.gsc(id))

  const list = useMemo(() => findings.data?.findings ?? [], [findings.data])
  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { all: list.length, open: 0, approval: 0, progress: 0, pending: 0, verified: 0 }
    for (const f of list) c[bucketOf(f.status)] += 1
    return c
  }, [list])
  const visible = bucket === "all" ? list : list.filter((f) => bucketOf(f.status) === bucket)
  const byCategory = useMemo(() => {
    const m = new Map<string, SiteFinding[]>()
    for (const f of visible) m.set(f.category, [...(m.get(f.category) ?? []), f])
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [visible])

  const inspectSite = () => {
    if (!siteId || inspecting || isActive) return
    setInspecting(true)
    setRunError(null)
    Search.triggerRun(id, siteId)
      .then(() => {
        setPolling(true)
        return runs.reload()
      })
      .catch((err: unknown) => {
        const status = (err as { status?: number })?.status
        setRunError(status === 409 ? "An inspection is already running for this site." : errorMessage(err))
      })
      .finally(() => setInspecting(false))
  }

  const stats: Stat[] = (
    [
      ["open", "Open problems", "Found and not yet acted on", "wrong"],
      ["approval", "Awaiting approval", "A fix is ready for you", "review"],
      ["progress", "Fix in progress", "Approved and being applied", "partial"],
      ["pending", "Verification pending", "Waiting for a re-inspection", "review"],
      ["verified", "Verified fixed", "Confirmed on the live site", "supported"],
    ] as const
  ).map(([key, label, hint, tone]) => ({
    key,
    label,
    hint,
    tone,
    value: findings.loading ? <Skeleton className="h-4 w-6" /> : counts[key],
    active: bucket === key,
    onSelect: () => setBucket(bucket === key ? "all" : key),
  }))

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Search"
        description="Keep this business discoverable: inspect the site, review problems with evidence, approve safe fixes, and verify they are live."
        actions={
          sites.length ? (
            <>
              {sites.length > 1 ? (
                <Select value={siteId ?? ""} onValueChange={setSelectedSiteId}>
                  <SelectTrigger className="h-8 w-[12rem] text-xs" aria-label="Website">
                    <GlobeIcon className="size-3.5 text-muted-foreground" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    {sites.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {domainOf(s.rootUrl)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                <PlusIcon />
                Add website
              </Button>
              <Button size="sm" onClick={inspectSite} disabled={inspecting || isActive}>
                {inspecting || isActive ? <Spinner /> : <PlayIcon />}
                {isActive ? "Inspecting…" : "Inspect site"}
              </Button>
            </>
          ) : null
        }
      />

      {overview.loading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : sites.length === 0 ? (
        <SearchOnboarding businessId={id} onCreated={() => void overview.reload()} gscStatus={gsc.data?.status ?? null} />
      ) : (
        <>
          <StatStrip stats={stats} />

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
            <Panel>
              <PanelHeader
                title="Needs attention"
                description={bucket === "all" ? "Ranked by severity. Each problem carries the exact observed evidence." : `Showing ${String(stats.find((s) => s.key === bucket)?.label ?? "").toLowerCase()}`}
              >
                {bucket !== "all" ? (
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setBucket("all")}>
                    Show all {counts.all}
                  </Button>
                ) : null}
              </PanelHeader>
              <div className="p-2">
                {findings.loading ? (
                  <Skeleton className="m-2 h-40" />
                ) : list.length === 0 ? (
                  <EmptyState
                    icon={latest ? <CircleCheckIcon /> : <ScanSearchIcon />}
                    title={latest ? "No open problems" : "No inspections yet"}
                    description={latest ? "The latest inspection recorded no open problems for the URLs it reached." : "Inspect the site to find concrete problems preventing proper discovery."}
                    action={
                      latest ? undefined : (
                        <Button size="sm" onClick={inspectSite} disabled={inspecting || isActive}>
                          <PlayIcon />
                          Inspect site
                        </Button>
                      )
                    }
                    className="m-2 py-10"
                  />
                ) : visible.length === 0 ? (
                  <p className="px-2 py-8 text-center text-xs text-muted-foreground">Nothing in this stage.</p>
                ) : (
                  byCategory.map(([category, items]) => (
                    <div key={category} className="pb-2">
                      <div className="flex items-center justify-between px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
                        <span className="font-medium">{sentenceCase(category)}</span>
                        <span className="tabular-nums">{items.length}</span>
                      </div>
                      {items.map((f) => (
                        <Link
                          key={f.id}
                          to={`/businesses/${id}/search/sites/${siteId}/findings/${f.id}`}
                          className="grid items-center gap-x-3 gap-y-1 rounded-lg px-2 py-2 text-xs transition-colors hover:bg-muted/50 sm:grid-cols-[minmax(0,1fr)_5rem_auto_1rem]"
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{findingKindLabel(f.findingKind)}</span>
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {domainOf(f.url)}
                              {pathOf(f.url)}
                            </span>
                          </span>
                          <SeverityDot severity={f.severity} />
                          <FindingStatusBadge status={f.status} />
                          <ChevronRightIcon className="hidden size-3.5 text-muted-foreground sm:block" />
                        </Link>
                      ))}
                    </div>
                  ))
                )}
              </div>
            </Panel>

            <div className="space-y-4 lg:sticky lg:top-0">
              <Panel>
                <PanelHeader title="Latest inspection" description={site ? domainOf(site.rootUrl) : undefined}>
                  {latest ? <RunBadge state={latest.state} /> : null}
                </PanelHeader>
                <div className="space-y-3 p-4 pt-3">
                  {runError ? (
                    <Alert variant="destructive">
                      <TriangleAlertIcon />
                      <AlertTitle className="font-normal">Could not start the inspection</AlertTitle>
                      <AlertDescription>{runError}</AlertDescription>
                    </Alert>
                  ) : null}
                  {runs.loading ? (
                    <Skeleton className="h-24" />
                  ) : !latest ? (
                    <p className="text-xs text-muted-foreground">One inspection at a time per site. Partial results stay visible instead of failing silently.</p>
                  ) : (
                    <>
                      <dl className="grid grid-cols-3 gap-2">
                        <Field label="Inspected">{latest.urlsInspected}</Field>
                        <Field label="Failed">{latest.urlsFailed}</Field>
                        <Field label="Problems">{latest.findingsProduced}</Field>
                      </dl>
                      {latest.urlsInspected + latest.urlsFailed > 0 ? (
                        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                          <span className="bg-supported" style={{ width: `${(latest.urlsInspected / (latest.urlsInspected + latest.urlsFailed)) * 100}%` }} />
                          <span className="bg-wrong" style={{ width: `${(latest.urlsFailed / (latest.urlsInspected + latest.urlsFailed)) * 100}%` }} />
                        </div>
                      ) : null}
                      <p className="text-[11px] text-muted-foreground">
                        Queued {relativeTime(latest.queuedAt)}
                        {latest.completedAt ? ` · finished ${formatDateTime(latest.completedAt)}` : ""}
                      </p>
                      {latest.state === "PARTIALLY_SUCCEEDED" ? (
                        <p className="rounded-md bg-partial-soft px-2.5 py-2 text-[11px] text-partial">
                          Inspection incomplete: {latest.urlsFailed} {latest.urlsFailed === 1 ? "URL" : "URLs"} could not be inspected. Listed problems reflect what was reached, not the whole site.
                        </p>
                      ) : null}
                      {latest.state === "FAILED" ? (
                        <p className="rounded-md bg-wrong-soft px-2.5 py-2 text-[11px] text-wrong">
                          Inspection failed: {latest.failureDetailSafe ?? latest.failureClass ?? "No evidence was collected."}
                        </p>
                      ) : null}
                      <Button asChild variant="outline" size="sm" className="w-full">
                        <Link to={`/businesses/${id}/search/sites/${siteId}/runs/${latest.id}`}>
                          <FileSearchIcon />
                          View evidence
                        </Link>
                      </Button>
                    </>
                  )}
                </div>
              </Panel>

              {sortedRuns.length > 1 ? (
                <Panel>
                  <PanelHeader title="Past inspections" />
                  <ul className="p-2 pt-1">
                    {sortedRuns.slice(1, 6).map((r) => (
                      <li key={r.id}>
                        <Link to={`/businesses/${id}/search/sites/${siteId}/runs/${r.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50">
                          <RunBadge state={r.state} />
                          <span className="flex-1 text-muted-foreground tabular-nums">{r.findingsProduced} problems</span>
                          <span className="text-[11px] text-muted-foreground">{relativeTime(r.queuedAt)}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              ) : null}

              <SearchConsoleCard status={gsc.data?.status ?? null} loading={gsc.loading} />
            </div>
          </div>
        </>
      )}

      <RegisterSiteDialog businessId={id} open={addOpen} onOpenChange={setAddOpen} onCreated={() => void overview.reload()} />
    </div>
  )
}

function SearchConsoleCard({ status, loading }: { status: string | null; loading: boolean }) {
  return (
    <Panel>
      <PanelHeader title="Search Console" description="Kept separate from what OpenRecord observed">
        {loading ? null : status === "CONNECTED" ? <Badge variant="supported">Connected</Badge> : <Badge variant="secondary">Not connected</Badge>}
      </PanelHeader>
      <p className="p-4 pt-2 text-[11px] leading-relaxed text-muted-foreground">
        {status === "CONNECTED"
          ? "Connected to Google Search Console."
          : "OpenRecord reports what it observed on the site (indexable or blocked); it never claims Google indexed a page without Search Console evidence."}
      </p>
    </Panel>
  )
}

function SearchOnboarding({ businessId, onCreated, gscStatus }: { businessId: string; onCreated: () => void; gscStatus: string | null }) {
  const [rootUrl, setRootUrl] = useState("https://")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="space-y-4">
      <Panel>
        <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center">
          <div className="space-y-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <GlobeIcon className="size-4" />
            </span>
            <h2 className="text-sm font-medium">See the site the way search engines do</h2>
            <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
              Register the business website. OpenRecord inspects only that site, records each problem with the exact evidence it saw, proposes safe fixes for you to approve, and
              re-inspects to verify them.
            </p>
            <form
              className="flex max-w-md gap-2 pt-1"
              onSubmit={(e) => {
                e.preventDefault()
                setPending(true)
                setError(null)
                Search.createSite(businessId, rootUrl.trim())
                  .then(onCreated)
                  .catch((err: unknown) => setError(errorMessage(err)))
                  .finally(() => setPending(false))
              }}
            >
              <Input aria-label="Website URL" inputMode="url" value={rootUrl} onChange={(e) => setRootUrl(e.currentTarget.value)} placeholder="https://example.com" />
              <Button type="submit" disabled={pending || rootUrl.trim().length < 10}>
                {pending ? <Spinner /> : <PlusIcon />}
                Register website
              </Button>
            </form>
            {error ? <p className="text-xs text-wrong">{error}</p> : null}
          </div>
          <StepFlow
            className="lg:grid-cols-2"
            steps={[
              { key: "inspect", icon: <ScanSearchIcon />, label: "Inspect", hint: "Crawl the registered site", state: "current" },
              { key: "evidence", icon: <FileSearchIcon />, label: "Review evidence", hint: "Each problem keeps what was observed", state: "todo" },
              { key: "approve", icon: <WrenchIcon />, label: "Approve a fix", hint: "Nothing changes without you", state: "todo" },
              { key: "verify", icon: <CheckCheckIcon />, label: "Verify live", hint: "Counted only after re-inspection", state: "todo" },
            ]}
          />
        </div>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <Panel>
          <PanelHeader title="What an inspection checks" description="Concrete problems, never a single number" />
          <div className="grid gap-x-6 gap-y-4 p-4 pt-3 sm:grid-cols-2 xl:grid-cols-3">
            {checkGroups.map((g) => (
              <div key={g.title} className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
                  {g.icon}
                  {g.title}
                </div>
                <ul className="space-y-0.5 pl-5 text-[11px] text-muted-foreground">
                  {g.kinds.map((k) => (
                    <li key={k}>{findingKindLabel(k)}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
        <SearchConsoleCard status={gscStatus} loading={false} />
      </div>
    </div>
  )
}

function RegisterSiteDialog({ businessId, open, onOpenChange, onCreated }: { businessId: string; open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => void }) {
  const [rootUrl, setRootUrl] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <Dialog open={open} onOpenChange={(next) => { onOpenChange(next); if (!next) { setRootUrl(""); setError(null) } }}>
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            setPending(true)
            setError(null)
            Search.createSite(businessId, rootUrl.trim())
              .then(() => { onCreated(); onOpenChange(false); setRootUrl("") })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setPending(false))
          }}
        >
          <DialogHeader>
            <DialogTitle>Add website</DialogTitle>
            <DialogDescription>OpenRecord inspects only this explicitly registered site.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="site-url">Website URL</Label>
            <Input id="site-url" autoFocus inputMode="url" value={rootUrl} onChange={(e) => setRootUrl(e.currentTarget.value)} placeholder="https://example.com" />
          </div>
          {error ? <p className="text-xs text-wrong">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || !rootUrl.trim()}>
              {pending ? <Spinner /> : null}
              Register
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

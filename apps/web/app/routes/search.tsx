import { useState } from "react"
import { Link, useParams } from "react-router"
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlayIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader } from "@/components/page"
import { Search, type SiteFinding, type SiteRun } from "@/lib/api"
import { errorMessage, formatDateTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

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

const findingKindLabel = (kind: string) => findingKindLabels[kind] ?? kind

function FindingStatusBadge({ status }: { status: string }) {
  if (status === "VERIFIED_FIXED") return <Badge variant="supported"><CircleCheckIcon />Verified fixed</Badge>
  if (status === "VERIFIED_NOT_FIXED") return <Badge variant="wrong"><CircleXIcon />Still present</Badge>
  if (status === "VERIFICATION_PENDING" || status === "FIX_APPLIED") return <Badge variant="review"><ClockIcon />Verification pending</Badge>
  if (status === "AWAITING_APPROVAL") return <Badge variant="review"><ClockIcon />Awaiting approval</Badge>
  if (status === "APPROVED" || status === "FIX_IN_PROGRESS") return <Badge variant="partial"><LoaderCircleIcon />Fix in progress</Badge>
  if (status === "DISMISSED") return <Badge variant="secondary">Dismissed</Badge>
  return <Badge variant="secondary">Open</Badge>
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
  const [inspecting, setInspecting] = useState<string | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const overview = useApi(`search-overview:${id}`, () => Search.overview(id))
  const o = overview.data?.overview ?? null
  const sites = o?.sites ?? []
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null)
  const siteId = selectedSiteId ?? sites[0]?.id ?? null

  const runs = useApi(siteId ? `site-runs:${siteId}` : null, () => Search.listRuns(id, siteId as string))
  const latest: SiteRun | null = [...(runs.data?.runs ?? [])].sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : -1))[0] ?? null
  const isActive = latest?.state === "QUEUED" || latest?.state === "RUNNING"
  const findings = useApi(siteId ? `site-findings:${siteId}` : null, () => Search.listFindings(id, siteId as string))
  const gsc = useApi(`gsc:${id}`, () => Search.gsc(id))

  const inspectSite = () => {
    if (!siteId || inspecting || isActive) return
    setInspecting(siteId)
    setRunError(null)
    Search.triggerRun(id, siteId)
      .then(() => runs.reload())
      .catch((err: unknown) => {
        const status = (err as { status?: number })?.status
        setRunError(status === 409 ? "An inspection is already running for this site." : errorMessage(err))
      })
      .finally(() => setInspecting(null))
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Search"
        description="Keep this business discoverable: inspect the site, review problems with evidence, approve safe fixes, and verify they are live."
      />

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Website</CardTitle>
          <CardDescription>
            {o?.website ?? "No site registered yet."}
            {o?.lastInspection ? ` Last inspection ${formatDateTime(o.lastInspection)} (${o.urlsInspected} URLs inspected).` : ""}
          </CardDescription>
          <CardAction>
            <Button onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Register website
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {overview.loading ? (
            <Skeleton className="h-20" />
          ) : sites.length === 0 ? (
            <EmptyState
              icon={<GlobeIcon />}
              title="No website registered"
              description="Register the business website to inspect how search engines see it."
              action={<Button onClick={() => setAddOpen(true)}><PlusIcon />Register website</Button>}
              className="py-10"
            />
          ) : (
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-muted-foreground">
              <span>Open problems: <span className="font-medium text-foreground tabular-nums">{o?.openFindings ?? 0}</span></span>
              <span>Awaiting approval: <span className="font-medium text-foreground tabular-nums">{o?.awaitingApproval ?? 0}</span></span>
              <span>Fixes in progress: <span className="font-medium text-foreground tabular-nums">{o?.fixesApplied ?? 0}</span></span>
              <span>Verification pending: <span className="font-medium text-foreground tabular-nums">{o?.verificationPending ?? 0}</span></span>
              <span>Verified fixed: <span className="font-medium text-foreground tabular-nums">{o?.verifiedFixes ?? 0}</span></span>
            </div>
          )}
          {sites.length > 1 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {sites.map((s) => (
                <Button key={s.id} variant={s.id === siteId ? "default" : "outline"} size="sm" onClick={() => setSelectedSiteId(s.id)}>
                  {s.rootUrl}
                </Button>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {siteId ? (
        <Card className="shadow-(--float-shadow)">
          <CardHeader>
            <CardTitle>Latest inspection</CardTitle>
            <CardDescription>One inspection at a time per site. Partial results stay visible instead of failing silently.</CardDescription>
            <CardAction>
              <Button onClick={inspectSite} disabled={inspecting !== null || isActive}>
                <PlayIcon />
                Inspect site
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            {runError ? (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle className="font-normal">Could not start the inspection</AlertTitle>
                <AlertDescription>{runError}</AlertDescription>
              </Alert>
            ) : null}
            {runs.loading ? (
              <Skeleton className="h-20" />
            ) : !latest ? (
              <EmptyState
                icon={<GlobeIcon />}
                title="No inspections yet"
                description="Inspect the site to find concrete problems preventing proper discovery."
                className="py-10"
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <RunBadge state={latest.state} />
                  <span className="text-xs text-muted-foreground">Queued {formatDateTime(latest.queuedAt)}</span>
                  {latest.completedAt ? <span className="text-xs text-muted-foreground">Finished {formatDateTime(latest.completedAt)}</span> : null}
                  <Button asChild variant="ghost" size="sm">
                    <Link to={`/businesses/${id}/search/sites/${siteId}/runs/${latest.id}`}>View evidence</Link>
                  </Button>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                  <span>URLs inspected: <span className="font-medium text-foreground tabular-nums">{latest.urlsInspected}</span></span>
                  <span>URLs failed: <span className="font-medium text-foreground tabular-nums">{latest.urlsFailed}</span></span>
                  <span>Problems recorded: <span className="font-medium text-foreground tabular-nums">{latest.findingsProduced}</span></span>
                </div>
                {latest.state === "PARTIALLY_SUCCEEDED" ? (
                  <Alert>
                    <TriangleAlertIcon />
                    <AlertTitle className="font-normal">Inspection incomplete</AlertTitle>
                    <AlertDescription>
                      {latest.urlsFailed} {latest.urlsFailed === 1 ? "URL" : "URLs"} could not be inspected. Listed problems reflect what was reached, not the whole site.
                    </AlertDescription>
                  </Alert>
                ) : null}
                {latest.state === "FAILED" ? (
                  <Alert variant="destructive">
                    <TriangleAlertIcon />
                    <AlertTitle className="font-normal">Inspection failed</AlertTitle>
                    <AlertDescription>{latest.failureDetailSafe ?? latest.failureClass ?? "No evidence was collected."}</AlertDescription>
                  </Alert>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      {siteId ? (
        <Card className="py-0">
          <CardHeader className="px-5 pt-5">
            <CardTitle>Needs attention</CardTitle>
            <CardDescription>Ranked by severity. Each problem carries the exact observed evidence.</CardDescription>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {findings.loading ? (
              <Skeleton className="h-40" />
            ) : (findings.data?.findings ?? []).length === 0 ? (
              <EmptyState
                icon={<CircleCheckIcon />}
                title="No open problems"
                description="The latest inspection recorded no open problems for the URLs it reached."
                className="py-10"
              />
            ) : (
              <ul className="divide-y rounded-lg border">
                {(findings.data?.findings ?? []).slice(0, 20).map((f: SiteFinding) => (
                  <li key={f.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{findingKindLabel(f.findingKind)}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{f.url}</p>
                    </div>
                    <FindingStatusBadge status={f.status} />
                    <Button asChild variant="outline" size="sm">
                      <Link to={`/businesses/${id}/search/sites/${siteId}/findings/${f.id}`}>Review evidence</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Search Console</CardTitle>
          <CardDescription>What Google reports is kept separate from what Ghostping observed on the site.</CardDescription>
        </CardHeader>
        <CardContent>
          {gsc.loading ? <Skeleton className="h-10" /> : (
            <p className="text-sm text-muted-foreground">
              {gsc.data?.status === "CONNECTED"
                ? "Connected to Google Search Console."
                : "Google Search Console is not connected. Ghostping reports what it observed on the site (indexable or blocked); it never claims Google indexed a page without Search Console evidence."}
            </p>
          )}
        </CardContent>
      </Card>

      <RegisterSiteDialog businessId={id} open={addOpen} onOpenChange={setAddOpen} onCreated={() => void overview.reload()} />
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
            <DialogTitle>Register website</DialogTitle>
            <DialogDescription>Ghostping inspects only this explicitly registered site.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="site-url">Website URL</Label>
            <Input id="site-url" autoFocus inputMode="url" value={rootUrl} onChange={(e) => setRootUrl(e.currentTarget.value)} placeholder="https://example.com" />
          </div>
          {error ? <p className="text-sm text-wrong">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending || !rootUrl.trim()}>Register</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

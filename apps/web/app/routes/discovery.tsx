import { useState } from "react"
import { Link, useParams } from "react-router"
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ClockIcon,
  ExternalLinkIcon,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState, PageHeader } from "@/components/page"
import { Discovery, type DiscoveryCandidateRelation, type DiscoveryRun, type DiscoveryRunState } from "@/lib/api"
import { errorMessage, formatDateTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function DiscoveryRunBadge({ state }: { state: DiscoveryRunState }) {
  switch (state) {
    case "QUEUED":
      return (
        <Badge variant="secondary">
          <ClockIcon />
          Queued
        </Badge>
      )
    case "RUNNING":
      return (
        <Badge variant="review">
          <LoaderCircleIcon className="animate-spin" />
          Running
        </Badge>
      )
    case "SUCCEEDED":
      return (
        <Badge variant="supported">
          <CircleCheckIcon />
          Completed
        </Badge>
      )
    case "PARTIAL":
      return (
        <Badge variant="partial">
          <CircleAlertIcon />
          Partial
        </Badge>
      )
    case "FAILED":
      return (
        <Badge variant="wrong">
          <CircleXIcon />
          Failed
        </Badge>
      )
  }
}

function CandidateMatchBadge({ relation }: { relation: DiscoveryCandidateRelation }) {
  switch (relation) {
    case "CURRENT":
      return <Badge variant="secondary">Current value found</Badge>
    case "HISTORICAL":
      return <Badge variant="partial">Historical value found</Badge>
    case "MIXED":
      return <Badge variant="review">Multiple known values</Badge>
  }
}

export function DiscoveryPage() {
  const { id = "" } = useParams()
  const [selectedScopeId, setSelectedScopeId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [polling, setPolling] = useState(false)
  const [triggering, setTriggering] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)

  const scopes = useApi(`discovery-scopes:${id}`, () => Discovery.listScopes(id))
  const scopeList = scopes.data?.scopes ?? []
  const scopeId = selectedScopeId ?? scopeList[0]?.id ?? null

  const runs = useApi(scopeId ? `discovery-runs:${scopeId}` : null, () =>
    Discovery.listRuns(id, scopeId as string).then((r) => {
      setPolling(r.runs.some((run) => run.state === "QUEUED" || run.state === "RUNNING"))
      return r
    }),
    { pollMs: polling ? 2000 : null },
  )
  const ordered = [...(runs.data?.runs ?? [])].sort((a, b) => (a.queued_at < b.queued_at ? 1 : -1))
  const latest: DiscoveryRun | null = ordered[0] ?? null
  const isActive = latest?.state === "QUEUED" || latest?.state === "RUNNING"

  const candidates = useApi(latest && scopeId ? `discovery-candidates:${latest.id}:${latest.state}` : null, () =>
    Discovery.listCandidates(id, { scope_id: scopeId as string, run_id: (latest as DiscoveryRun).id }),
  )
  const candidateList = candidates.data?.candidates ?? []
  const truthChanged = candidateList.some((c) => c.truth_changed_since_scan)

  const scanSite = () => {
    if (!scopeId || triggering || isActive) return
    setTriggering(true)
    setRunError(null)
    Discovery.triggerRun(id, scopeId)
      .then(() => {
        setPolling(true)
        return runs.reload()
      })
      .catch((err: unknown) => {
        const status = (err as { status?: number })?.status
        setRunError(status === 409 ? "A scan is already running for this site." : errorMessage(err))
      })
      .finally(() => setTriggering(false))
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Discovery"
        description="Find pages on sites you operate that appear to contain known fact values."
        actions={
          <Button asChild variant="outline">
            <Link to={`/businesses/${id}/representations`}>
              <ArrowLeftIcon />
              All representations
            </Link>
          </Button>
        }
      />

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Owned site scopes</CardTitle>
          <CardDescription>Ghostping scans only this explicitly configured site scope.</CardDescription>
          <CardAction>
            <Button onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Add owned site
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {scopes.loading ? (
            <Skeleton className="h-20" />
          ) : scopeList.length === 0 ? (
            <EmptyState
              icon={<GlobeIcon />}
              title="No owned sites yet"
              description="Add the site you operate. Ghostping scans only this explicitly configured site scope."
              action={
                <Button onClick={() => setAddOpen(true)}>
                  <PlusIcon />
                  Add owned site
                </Button>
              }
              className="py-10"
            />
          ) : (
            <ul className="divide-y rounded-lg border">
              {scopeList.map((s) => (
                <li key={s.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{s.root_url}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Marked as owned by the operator.</p>
                  </div>
                  {s.id === scopeId ? (
                    <Badge variant="secondary">Selected</Badge>
                  ) : (
                    <Button variant="outline" size="sm" onClick={() => setSelectedScopeId(s.id)}>
                      View scans
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {scopeId ? (
        <Card className="shadow-(--float-shadow)">
          <CardHeader>
            <CardTitle>Latest scan</CardTitle>
            <CardDescription>One scan at a time per site. A new scan waits until the current one finishes.</CardDescription>
            <CardAction>
              <Button onClick={scanSite} disabled={triggering || isActive}>
                <PlayIcon />
                Scan site
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-3">
            {runError ? (
              <Alert variant="destructive">
                <TriangleAlertIcon />
                <AlertTitle className="font-normal">Could not start the scan</AlertTitle>
                <AlertDescription>{runError}</AlertDescription>
              </Alert>
            ) : null}
            {runs.loading ? (
              <Skeleton className="h-20" />
            ) : !latest ? (
              <EmptyState
                icon={<GlobeIcon />}
                title="No scans yet"
                description="Scan this site to look for pages that appear to contain known fact values."
                className="py-10"
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <DiscoveryRunBadge state={latest.state} />
                  <span className="text-xs text-muted-foreground">Queued {formatDateTime(latest.queued_at)}</span>
                  {latest.completed_at ? (
                    <span className="text-xs text-muted-foreground">Finished {formatDateTime(latest.completed_at)}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                  <span>
                    Pages checked: <span className="font-medium text-foreground tabular-nums">{latest.pages_checked}</span>
                  </span>
                  <span>
                    Pages skipped: <span className="font-medium text-foreground tabular-nums">{latest.pages_skipped}</span>
                  </span>
                  <span>
                    Candidates found: <span className="font-medium text-foreground tabular-nums">{latest.candidates_found}</span>
                  </span>
                </div>
                {latest.state === "PARTIAL" && latest.partial_reason ? (
                  <Alert>
                    <TriangleAlertIcon />
                    <AlertTitle className="font-normal">Scan stopped early</AlertTitle>
                    <AlertDescription>{latest.partial_reason}</AlertDescription>
                  </Alert>
                ) : null}
                {latest.state === "FAILED" && latest.failure_reason ? (
                  <Alert variant="destructive">
                    <TriangleAlertIcon />
                    <AlertTitle className="font-normal">Scan failed</AlertTitle>
                    <AlertDescription>{latest.failure_reason}</AlertDescription>
                  </Alert>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      {latest ? (
        <Card className="py-0">
          <CardHeader className="px-5 pt-5">
            <CardTitle>Candidates</CardTitle>
            <CardDescription>
              Discovery finds pages that appear to contain known fact values. A candidate is not a tracked representation until it is
              explicitly configured.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-5 pb-5">
            <p className="text-sm text-muted-foreground">
              Ghostping found {latest.candidates_found} {latest.candidates_found === 1 ? "candidate" : "candidates"} in this scan.
            </p>
            {truthChanged ? (
              <Alert>
                <TriangleAlertIcon />
                <AlertTitle className="font-normal">Approved truth changed since this scan</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-3">
                  <span>Some candidates were matched against older fact versions. Rescan to compare against current approved truth.</span>
                  <Button variant="outline" size="sm" onClick={scanSite} disabled={triggering || isActive}>
                    <PlayIcon />
                    Rescan site
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {candidates.loading ? (
              <Skeleton className="h-40" />
            ) : candidateList.length === 0 ? (
              <EmptyState
                icon={<GlobeIcon />}
                title="No candidates in this scan"
                description="No pages in this scan appeared to contain known fact values. An empty result reflects what this scan reached, not proof a value is absent elsewhere."
                className="py-10"
              />
            ) : (
              <div className="overflow-x-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="pl-5">Approved fact</TableHead>
                      <TableHead>Approved value</TableHead>
                      <TableHead>Found value</TableHead>
                      <TableHead>Page</TableHead>
                      <TableHead>Match</TableHead>
                      <TableHead>Found via</TableHead>
                      <TableHead>Last scan</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {candidateList.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="pl-5">
                          <div className="font-medium">{sentenceCase(c.fact_predicate)}</div>
                          <Link to={`/businesses/${id}/truth`} className="text-xs text-muted-foreground hover:underline">
                            View truth
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{c.approved_value}</TableCell>
                        <TableCell className="font-medium">{c.found_value}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="max-w-40 truncate text-muted-foreground">{domainOf(c.page_url)}</span>
                            <Button asChild variant="ghost" size="sm">
                              <a href={c.page_url} target="_blank" rel="noreferrer">
                                Open page
                                <ExternalLinkIcon />
                              </a>
                            </Button>
                          </div>
                        </TableCell>
                        <TableCell>
                          <CandidateMatchBadge relation={c.relation} />
                          {c.evidence && c.evidence.length > 0 ? (
                            <div className="mt-1 max-w-56 space-y-0.5">
                              {c.evidence.slice(0, 5).map((e, i) => (
                                <p key={`${e.locator}-${i}`} className="truncate text-xs text-muted-foreground" title={`${e.locator}: ${e.snippet}`}>
                                  {e.locator}: {e.snippet.length > 120 ? `${e.snippet.slice(0, 120)}…` : e.snippet}
                                </p>
                              ))}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-muted-foreground">{sentenceCase(c.found_via)}</TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(c.scanned_at)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <AddOwnedSiteDialog businessId={id} open={addOpen} onOpenChange={setAddOpen} onCreated={(scopeId) => void scopes.reload().then(() => setSelectedScopeId(scopeId))} />
    </div>
  )
}

function AddOwnedSiteDialog({
  businessId,
  open,
  onOpenChange,
  onCreated,
}: {
  businessId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (scopeId: string) => void
}) {
  const [rootUrl, setRootUrl] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setRootUrl("")
    setError(null)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            setPending(true)
            setError(null)
            Discovery.createScope(businessId, rootUrl.trim())
              .then(({ scope }) => {
                onCreated(scope.id)
                onOpenChange(false)
                reset()
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setPending(false))
          }}
        >
          <DialogHeader>
            <DialogTitle>Add owned site</DialogTitle>
            <DialogDescription>Ghostping scans only this explicitly configured site scope.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="scope-url">Site URL</Label>
            <Input
              id="scope-url"
              autoFocus
              inputMode="url"
              value={rootUrl}
              onChange={(e) => setRootUrl(e.currentTarget.value)}
              placeholder="https://example.com"
            />
          </div>
          {error ? <p className="text-sm text-wrong">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !rootUrl.trim()}>
              Add site
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

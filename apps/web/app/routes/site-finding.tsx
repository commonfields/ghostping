import { Link, useParams } from "react-router"
import { ArrowLeftIcon, CircleCheckIcon, CircleXIcon, ClockIcon, LoaderCircleIcon } from "lucide-react"
import { useState } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader } from "@/components/page"
import { Search, type FixProposal, type SiteMutation, type SiteVerification } from "@/lib/api"
import { errorMessage, formatDateTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { findingKindLabels } from "./search"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const label = (kind: string) => findingKindLabels[kind] ?? kind

// Fix kinds with a deterministic source transform: approval must bind to
// the exact prepared change (mirrors SOURCE_TRANSFORMS in site-operator).
const AUTO_APPLY_KINDS = new Set(["REMOVE_NOINDEX_META"])

export function SiteFindingPage() {
  const { id = "", siteId = "", findingId = "" } = useParams()
  const detail = useApi(`site-finding:${findingId}`, () => Search.getFinding(id, siteId, findingId))
  const [working, setWorking] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [patch, setPatch] = useState<string | null>(null)

  const f = detail.data?.finding ?? null
  const proposals = detail.data?.proposals ?? []
  const mutations = detail.data?.mutations ?? []
  const verifications = detail.data?.verifications ?? []
  const activeProposal: FixProposal | null = proposals.find((p) => p.status === "APPROVED" || p.status === "PROPOSED") ?? proposals[0] ?? null
  const latestVerification: SiteVerification | null = verifications[verifications.length - 1] ?? null

  const automated = activeProposal !== null && activeProposal.classification !== "MANUAL_ONLY" && AUTO_APPLY_KINDS.has(activeProposal.fixKind)
  const prepared = activeProposal?.patchSha256 != null

  const prepare = () => {
    if (!activeProposal || working) return
    setWorking("prepare")
    setError(null)
    Search.prepareFix(id, activeProposal.id)
      .then(() => detail.reload())
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setWorking(null))
  }

  const approve = (approved: boolean) => {
    if (!activeProposal || working) return
    setWorking("approve")
    setError(null)
    Search.approveFix(id, activeProposal.id, approved, activeProposal.patchSha256)
      .then(() => detail.reload())
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setWorking(null))
  }

  const apply = () => {
    if (!activeProposal || working) return
    setWorking("apply")
    setError(null)
    setPatch(null)
    Search.applyFix(id, activeProposal.id)
      .then(({ patch: p }) => {
        setPatch(p)
        return detail.reload()
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setWorking(null))
  }

  const verify = () => {
    if (!f || working) return
    setWorking("verify")
    setError(null)
    Search.verifyFinding(id, f.id)
      .then(() => detail.reload())
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setWorking(null))
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={f ? label(f.findingKind) : "Problem"}
        description={f?.url ?? "Loading the observed evidence."}
        actions={
          <Button asChild variant="outline">
            <Link to={`/businesses/${id}/search`}>
              <ArrowLeftIcon />
              Search
            </Link>
          </Button>
        }
      />
      {error ? (
        <Alert variant="destructive">
          <AlertTitle className="font-normal">Action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {detail.loading || !f ? (
        <Skeleton className="h-60" />
      ) : (
        <>
          <Card className="shadow-(--float-shadow)">
            <CardHeader>
              <CardTitle>Observed evidence</CardTitle>
              <CardDescription>Detected {formatDateTime(f.detectedAt)} · Confidence {f.confidence.toLowerCase()}</CardDescription>
              <CardAction><FindingBadge status={f.status} /></CardAction>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <p className="text-xs font-medium text-muted-foreground">Affected URL</p>
                <p className="mt-1 break-all font-mono text-xs">{f.url}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-muted-foreground">Observed evidence</p>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{JSON.stringify(f.evidence, null, 2)}</pre>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Why it matters</p>
                  <p className="mt-1 text-xs">{f.diagnosis}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground">Recommended fix</p>
                  <p className="mt-1 text-xs">{f.recommendedAction}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-(--float-shadow)">
            <CardHeader>
              <CardTitle>Proposed fix</CardTitle>
              <CardDescription>
                {activeProposal
                  ? `${activeProposal.fixKind} · ${activeProposal.classification === "MANUAL_ONLY" ? "manual change required" : activeProposal.requiresApproval ? "requires approval" : "safe to apply automatically"}`
                  : "No automated fix is available for this problem."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!activeProposal ? (
                <EmptyState icon={<ClockIcon />} title="Manual change required" description="OpenRecord cannot safely derive this correction. Apply it by hand, then run verification." className="py-8" />
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">{activeProposal.rationale}</p>
                  <p className="text-xs text-muted-foreground">Risk: {activeProposal.risk}</p>
                  {activeProposal.patch || activeProposal.beforeText ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">Before</p>
                        <pre className="mt-1 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{activeProposal.beforeText ?? "(unchanged)"}</pre>
                      </div>
                      <div>
                        <p className="text-xs font-medium text-muted-foreground">After</p>
                        <pre className="mt-1 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{activeProposal.afterText ?? "(manual change)"}</pre>
                      </div>
                    </div>
                  ) : null}
                  {activeProposal.patch ? (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">
                        {prepared ? `Exact change to ${activeProposal.filePath ?? "the source file"} (approval covers only this diff)` : "Diff"}
                      </p>
                      <pre className="mt-1 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{activeProposal.patch}</pre>
                    </div>
                  ) : null}
                  {patch ? (
                    <div>
                      <p className="text-xs font-medium text-muted-foreground">Applied change</p>
                      <pre className="mt-1 overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{patch}</pre>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {activeProposal.status === "PROPOSED" && automated ? (
                      <Button variant={prepared ? "outline" : "default"} onClick={prepare} disabled={working !== null}>
                        {prepared ? "Re-read source file" : "Prepare exact change"}
                      </Button>
                    ) : null}
                    {activeProposal.status === "PROPOSED" ? (
                      <>
                        <Button onClick={() => approve(true)} disabled={working !== null || (automated && !prepared)}>Approve fix</Button>
                        <Button variant="outline" onClick={() => approve(false)} disabled={working !== null}>Reject</Button>
                      </>
                    ) : null}
                    {activeProposal.status === "APPROVED" && ["APPROVED", "AWAITING_APPROVAL"].includes(f.status) ? (
                      <Button onClick={apply} disabled={working !== null}>Apply approved fix</Button>
                    ) : null}
                    {["FIX_APPLIED", "VERIFIED_NOT_FIXED"].includes(f.status) ? (
                      <Button variant="outline" onClick={verify} disabled={working !== null}>Verify on live site</Button>
                    ) : null}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card className="shadow-(--float-shadow)">
            <CardHeader>
              <CardTitle>Verification</CardTitle>
              <CardDescription>A fix counts only after OpenRecord re-observes the live page.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {mutations.length === 0 && verifications.length === 0 ? (
                <p className="text-xs text-muted-foreground">No changes or verifications recorded yet.</p>
              ) : (
                <>
                  {mutations.map((m: SiteMutation) => (
                    <div key={m.id} className="rounded-lg border p-3 text-xs">
                      <p className="font-medium">Change {m.state.toLowerCase().replace(/_/g, " ")}</p>
                      {m.branch ? <p className="text-muted-foreground">Branch: <span className="font-mono">{m.branch}</span></p> : null}
                      {m.commitSha ? <p className="text-muted-foreground">Commit: <span className="font-mono">{m.commitSha.slice(0, 12)}</span></p> : null}
                      {m.prUrl ? <p className="text-muted-foreground">Pull request: <a className="underline" href={m.prUrl}>{m.prUrl}</a></p> : <p className="text-muted-foreground">OpenRecord never merges automatically; a human merges the pull request.</p>}
                      <RecordIdentityForm businessId={id} mutation={m} onRecorded={() => detail.reload()} />
                    </div>
                  ))}
                  {verifications.map((v: SiteVerification) => (
                    <div key={v.id} className="rounded-lg border p-3 text-xs">
                      <p className="font-medium">
                        {v.result === "VERIFIED_FIXED" ? "OpenRecord verified the fix on the live site." : v.result === "VERIFIED_NOT_FIXED" ? "The live site still shows the problem." : "Verification pending."}
                      </p>
                      {v.detail ? <p className="text-muted-foreground">{v.detail}</p> : null}
                      <p className="text-xs text-muted-foreground">{formatDateTime(v.checkedAt)}</p>
                    </div>
                  ))}
                  {latestVerification?.result === "VERIFIED_FIXED" ? (
                    <p className="text-xs text-muted-foreground">Before → change → after is preserved in the history below.</p>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
              <CardDescription>Every status change is preserved; nothing is silently overwritten.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-xs">
                {(detail.data?.history ?? []).map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    <span className="font-mono text-xs">{formatDateTime(h.createdAt)}</span>
                    <span>{h.fromStatus ?? "—"} → {h.toStatus}</span>
                    <span className="text-xs">by {h.actor}</span>
                    {h.detail ? <span className="text-xs">{h.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function FindingBadge({ status }: { status: string }) {
  if (status === "VERIFIED_FIXED") return <Badge variant="supported"><CircleCheckIcon />Verified fixed</Badge>
  if (status === "VERIFIED_NOT_FIXED") return <Badge variant="wrong"><CircleXIcon />Still present</Badge>
  if (status === "VERIFICATION_PENDING" || status === "FIX_APPLIED") return <Badge variant="review"><ClockIcon />Verification pending</Badge>
  if (status === "AWAITING_APPROVAL") return <Badge variant="review"><ClockIcon />Awaiting approval</Badge>
  if (status === "APPROVED" || status === "FIX_IN_PROGRESS") return <Badge variant="partial"><LoaderCircleIcon />Fix in progress</Badge>
  return <Badge variant="secondary">Open</Badge>
}

function RecordIdentityForm({ businessId, mutation, onRecorded }: { businessId: string; mutation: SiteMutation; onRecorded: () => void }) {
  const [open, setOpen] = useState(false)
  const [prUrl, setPrUrl] = useState(mutation.prUrl ?? "")
  const [commitSha, setCommitSha] = useState(mutation.commitSha ?? "")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (mutation.state === "MERGED" || mutation.state === "FAILED") return null
  const nextState = mutation.state === "CREATED" ? "BRANCH_CREATED" : mutation.state === "BRANCH_CREATED" ? "PR_OPEN" : "MERGED"
  const nextLabel = nextState === "BRANCH_CREATED" ? "Record branch" : nextState === "PR_OPEN" ? "Record pull request" : "Record merge"
  return (
    <div className="mt-2">
      {!open ? (
        <Button variant="outline" size="sm" onClick={() => { setOpen(true); setError(null) }}>{nextLabel}</Button>
      ) : (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            setPending(true)
            setError(null)
            const payload: { branch?: string; commitSha?: string; prUrl?: string; state: string } = { state: nextState }
            if (mutation.branch) payload.branch = mutation.branch
            if (commitSha.trim()) payload.commitSha = commitSha.trim()
            if (prUrl.trim()) payload.prUrl = prUrl.trim()
            Search.recordMutationIdentity(businessId, mutation.id, payload)
              .then(() => { setOpen(false); onRecorded() })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setPending(false))
          }}
        >
          <p className="text-xs text-muted-foreground">Record what was observed outside OpenRecord. Merges are observed here, never performed.</p>
          {nextState !== "MERGED" ? (
            <>
              <div className="grid gap-1">
                <Label htmlFor={`commit-${mutation.id}`}>Commit</Label>
                <Input id={`commit-${mutation.id}`} value={commitSha} onChange={(e) => setCommitSha(e.currentTarget.value)} placeholder="abc123…" />
              </div>
            </>
          ) : null}
          {nextState === "PR_OPEN" ? (
            <div className="grid gap-1">
              <Label htmlFor={`pr-${mutation.id}`}>Pull request URL</Label>
              <Input id={`pr-${mutation.id}`} value={prUrl} onChange={(e) => setPrUrl(e.currentTarget.value)} placeholder="https://github.com/org/repo/pull/123" />
            </div>
          ) : null}
          {error ? <p className="text-xs text-wrong">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>{pending ? "Recording…" : nextLabel}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </div>
  )
}

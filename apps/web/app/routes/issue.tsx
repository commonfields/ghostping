import { Link, useParams } from "react-router"
import { ArrowLeftIcon, BookCheckIcon, LinkIcon, MessageSquareQuoteIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader } from "@/components/page"
import { ControlBadge, IssueStateBadge, RepresentationStateBadge } from "@/components/status"
import { Issues, type CitationEvidence } from "@/lib/api"
import { formatDateTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function IssueDetailPage() {
  const { id = "", claimId = "" } = useParams()
  const { data, loading, error } = useApi(`issue:${claimId}`, () => Issues.get(id, claimId))
  const issue = data ?? null

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }
  if (error || !issue) {
    return <EmptyState icon={<TriangleAlertIcon />} title="Issue not found" description="It may have been resolved, removed, or belong to a different account." />
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Issue"
        description="One AI claim, the approved truth beside it, and the source evidence around it."
        actions={
          <Button asChild variant="outline">
            <Link to={`/businesses/${id}/issues`}>
              <ArrowLeftIcon />
              All issues
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <IssueStateBadge state={issue.state} />
        <span className="text-sm text-muted-foreground">
          Seen on <span className="font-medium text-foreground">{sentenceCase(issue.provider)}</span>
          {issue.observed_model ? <span> ({issue.observed_model})</span> : null}
          <span> on {formatDateTime(issue.collected_at)}</span>
        </span>
      </div>

      {issue.question_prompt ? (
        <p className="text-sm text-muted-foreground">
          Asked <span className="font-medium text-foreground">&ldquo;{issue.question_prompt}&rdquo;</span>
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-(--float-shadow)">
          <CardHeader>
            <CardTitle>AI said</CardTitle>
            <CardDescription>The exact transcribed claim.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-[15px] leading-relaxed">{issue.claim_text}</p>
            <Button asChild variant="outline" size="sm">
              <Link to={`/observations/${issue.observation_id}`}>View full AI answer</Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="shadow-(--float-shadow)">
          <CardHeader>
            <CardTitle>Approved truth</CardTitle>
            <CardDescription>What the business stands behind.</CardDescription>
          </CardHeader>
          <CardContent>
            {issue.facts.length > 0 ? (
              <dl className="space-y-2">
                {issue.facts.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-baseline gap-x-2">
                    <dt className="text-sm text-muted-foreground">{sentenceCase(f.predicate)}</dt>
                    <dd className="text-[15px] font-medium">{f.valueText}</dd>
                    <dd className="text-xs text-muted-foreground">{f.status}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">No approved fact was linked to this verdict.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Source evidence</CardTitle>
          <CardDescription>What the AI cited, and what Ghostping observed there.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {issue.citation_evidence.length === 0 ? (
            <p className="text-sm text-muted-foreground">No source citation was returned with this observation.</p>
          ) : (
            <ul className="space-y-3">
              {issue.citation_evidence.map((c) => (
                <CitationCard key={c.uri} businessId={id} citation={c} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Reviewer decision</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {issue.verdict ? (
            <>
              <p className="text-sm">
                Verdict <span className="font-medium">{sentenceCase(issue.verdict)}</span>
              </p>
              {issue.notes ? <p className="text-sm text-muted-foreground">{issue.notes}</p> : null}
            </>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted-foreground">No reviewer has judged this claim yet.</p>
              <Button asChild size="sm">
                <Link to={`/observations/${issue.observation_id}`}>Review claim</Link>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function CitationCard({ businessId, citation: c }: { businessId: string; citation: CitationEvidence }) {
  return (
    <li className="space-y-3 rounded-lg border px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <LinkIcon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{domainOf(c.uri)}</span>
        {c.tracked ? <ControlBadge control={c.tracked.control} /> : null}
      </div>
      {c.tracked ? (
        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg bg-muted/60 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Observed there</div>
            <p className="text-sm font-medium">{c.tracked.observed_value ?? "Not observed yet"}</p>
          </div>
          <div className="rounded-lg bg-muted/60 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Source state</div>
            <RepresentationStateBadge state={c.tracked.finding} />
          </div>
          <div className="rounded-lg bg-muted/60 p-3">
            <div className="mb-1 text-xs font-medium text-muted-foreground">Evidence</div>
            <Button asChild variant="link" size="sm" className="h-auto p-0">
              <Link to={`/businesses/${businessId}/representations/${c.tracked.binding_id}`}>View tracked representation</Link>
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Representation <span className="font-medium text-foreground">Not tracked</span> — Ghostping does not observe this URL, so there is no
          finding for it.
        </p>
      )}
      <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
        <BookCheckIcon className="mt-0.5 size-3.5 shrink-0" />
        The AI cited a source{c.tracked ? " that Ghostping also observed" : ""}. Citation shows the source was referenced; it does not prove the
        source caused the answer.
      </p>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <MessageSquareQuoteIcon className="size-3.5" />
        {c.title ?? c.uri}
      </p>
    </li>
  )
}

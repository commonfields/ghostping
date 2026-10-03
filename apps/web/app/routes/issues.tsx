import { useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import { ArrowUpRightIcon, BookCheckIcon, InboxIcon, LinkIcon, MessageSquareQuoteIcon, PenLineIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState, PageHeader } from "@/components/page"
import { IssueStateBadge, issueStateMeta, RepresentationStateBadge } from "@/components/status"
import { Issues, type IssueState, type IssueWithEvidence } from "@/lib/api"
import { formatDate, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"

type Filter = "ALL" | IssueState
const filters: Filter[] = ["ALL", "WRONG", "PARTIAL", "UNKNOWN", "NEEDS_REVIEW"]

export function IssuesPage() {
  const { id = "" } = useParams()
  const { data, loading } = useApi(`issues:${id}`, () => Issues.list(id))
  const [filter, setFilter] = useState<Filter>("ALL")

  const issues = useMemo(() => data?.issues ?? [], [data])
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ALL: issues.length, WRONG: 0, PARTIAL: 0, UNKNOWN: 0, NEEDS_REVIEW: 0 }
    for (const i of issues) c[i.state] = (c[i.state] ?? 0) + 1
    return c
  }, [issues])
  const visible = filter === "ALL" ? issues : issues.filter((i) => i.state === filter)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Issues"
        description="Claims from AI answers that disagree with your approved facts, or still need a verdict. Supported claims stay out of this inbox."
      />

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          {filters.map((f) => (
            <TabsTrigger key={f} value={f}>
              {f === "ALL" ? "All" : issueStateMeta[f].label}
              <span className="rounded bg-muted px-1.5 text-xs tabular-nums text-muted-foreground in-data-[state=active]:bg-secondary">
                {counts[f]}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {loading ? (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<InboxIcon />}
          title={filter === "ALL" ? "Inbox is clear" : `No issues marked ${issueStateMeta[filter].label.toLowerCase()}`}
          description={
            filter === "ALL"
              ? "Nothing disagrees with your approved facts right now. Run another check to keep an eye on new answers."
              : "Switch to another filter to see the rest of the inbox."
          }
          action={
            filter === "ALL" ? (
              <Button asChild variant="outline">
                <Link to={`/businesses/${id}/checks`}>Go to checks</Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-4">
          {visible.map((i) => (
            <li key={i.claim_id}>
              <IssueCard issue={i} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function IssueCard({ issue }: { issue: IssueWithEvidence }) {
  const { id = "" } = useParams()
  const reviewed = issue.state !== "NEEDS_REVIEW"
  const tracked = issue.citation_evidence.filter((c) => c.tracked !== null)
  const untracked = issue.citation_evidence.filter((c) => c.tracked === null)
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3">
        <IssueStateBadge state={issue.state} />
        <span className="text-sm text-muted-foreground">
          Seen on <span className="font-medium text-foreground">{sentenceCase(issue.provider)}</span>
          {issue.observed_model ? <span> ({issue.observed_model})</span> : null}
          <span> on {formatDate(issue.collected_at)}</span>
        </span>
        <Button asChild variant={reviewed ? "ghost" : "default"} size="sm" className="ml-auto">
          {reviewed ? (
            <Link to={`/businesses/${id}/issues/${issue.claim_id}`}>
              <ArrowUpRightIcon />
              View issue
            </Link>
          ) : (
            <Link to={`/observations/${issue.observation_id}`}>
              <PenLineIcon />
              Review claim
            </Link>
          )}
        </Button>
      </div>

      <CardContent className="space-y-4 px-5 py-5">
        {issue.question_prompt ? (
          <p className="text-sm text-muted-foreground">
            Asked <span className="font-medium text-foreground">&ldquo;{issue.question_prompt}&rdquo;</span>
          </p>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-lg bg-muted/60 p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <MessageSquareQuoteIcon className="size-3.5" />
              The AI said
            </div>
            <p className="text-[15px] leading-relaxed">{issue.claim_text}</p>
          </div>
          <div className="rounded-lg border p-4">
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <BookCheckIcon className="size-3.5" />
              Your approved fact
            </div>
            {issue.facts.length > 0 ? (
              <dl className="space-y-1.5">
                {issue.facts.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-baseline gap-x-2">
                    <dt className="text-sm text-muted-foreground">{sentenceCase(f.predicate)}</dt>
                    <dd className="text-[15px] font-medium">{f.valueText}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                {reviewed ? "No approved fact was linked to this verdict." : "Not compared yet. Review the claim to link the facts it touches."}
              </p>
            )}
          </div>
        </div>

        {issue.notes ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Reviewer note </span>
            {issue.notes}
          </p>
        ) : null}

        {tracked.length > 0 ? (
          <div className="space-y-2 rounded-lg border p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <LinkIcon className="size-3.5" />
              Cited source evidence
            </div>
            {tracked.map((c) => (
              <div key={c.uri} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">{domainOf(c.uri)}</span>
                {c.tracked?.observed_value ? <span className="text-muted-foreground">Observed there {c.tracked.observed_value}</span> : null}
                {c.tracked ? <RepresentationStateBadge state={c.tracked.finding} /> : null}
              </div>
            ))}
            <p className="text-xs text-muted-foreground">Citation shows the source was referenced; it does not prove the source caused the answer.</p>
          </div>
        ) : null}
        {untracked.length > 0 ? (
          <div className="space-y-1 rounded-lg border p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <LinkIcon className="size-3.5" />
              Cited source
            </div>
            {untracked.map((c) => (
              <p key={c.uri} className="text-sm">
                <span className="font-medium">{domainOf(c.uri)}</span>{" "}
                <span className="text-muted-foreground">— representation not tracked</span>
              </p>
            ))}
          </div>
        ) : null}
        {issue.citation_evidence.length === 0 ? (
          <p className="text-sm text-muted-foreground">No source citation returned.</p>
        ) : null}
      </CardContent>

    </Card>
  )
}

function domainOf(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

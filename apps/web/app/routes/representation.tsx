import { Link, useParams } from "react-router"
import { ArrowLeftIcon, ExternalLinkIcon, MessageSquareQuoteIcon, TriangleAlertIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState, PageHeader } from "@/components/page"
import { ControlBadge, RepresentationStateBadge } from "@/components/status"
import { Representations } from "@/lib/api"
import { formatDateTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"

export function RepresentationDetailPage() {
  const { id = "", bindingId = "" } = useParams()
  const { data, loading, error } = useApi(`representation:${bindingId}`, () => Representations.get(id, bindingId))
  const d = data ?? null

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-16" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }
  if (error || !d) {
    return <EmptyState icon={<TriangleAlertIcon />} title="Representation not found" description="It may have been removed, or it belongs to a different account." />
  }

  const effective = d.current?.effective_observation ?? null
  const latest = d.current?.latest_attempt ?? null
  const failedLatest = latest?.collection_state === "FAILED" && effective !== null

  return (
    <div className="space-y-6">
      <PageHeader
        title="Representation"
        description={`${d.fact.predicate} as observed at ${domainOf(d.source.url)}.`}
        actions={
          <Button asChild variant="outline">
            <Link to={`/businesses/${id}/representations`}>
              <ArrowLeftIcon />
              All representations
            </Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="shadow-(--float-shadow)">
          <CardHeader>
            <CardTitle>Approved facts</CardTitle>
            <CardDescription>The version Ghostping compares against.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-muted-foreground">{sentenceCase(d.fact.predicate)}</span>
              <span className="text-[15px] font-medium">{d.fact.valueText}</span>
              <span className="text-xs text-muted-foreground tabular-nums">v{d.fact.version}</span>
            </div>
            <p className="text-xs text-muted-foreground">Status {sentenceCase(d.fact.status)}</p>
          </CardContent>
        </Card>

        <Card className="shadow-(--float-shadow)">
          <CardHeader>
            <CardTitle>Source</CardTitle>
            <CardDescription>One configured URL Ghostping is allowed to observe.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <a href={d.source.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[15px] font-medium hover:underline">
              <span className="break-all">{d.source.url}</span>
              <ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
            </a>
            <div>
              <ControlBadge control={d.source.control} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Current representation</CardTitle>
          <CardDescription>Derived from the last successful observation. A failed check never erases it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {d.current ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <RepresentationStateBadge state={d.current.finding.state} />
                <span className="text-[15px] font-medium">{effective?.extracted_value ?? "Not observed yet"}</span>
              </div>
              <p className="text-sm text-muted-foreground">{d.current.finding.reason}</p>
              {effective ? (
                <p className="text-xs text-muted-foreground">Last successful observation {formatDateTime(effective.completed_at)}</p>
              ) : null}
              {failedLatest && latest ? (
                <Alert>
                  <TriangleAlertIcon />
                  <AlertTitle className="font-normal">Latest check failed</AlertTitle>
                  <AlertDescription>
                    {formatDateTime(latest.completed_at)}
                    {latest.failure ? <span> ({sentenceCase(latest.failure)})</span> : null}. The state above still reflects the last good
                    observation.
                  </AlertDescription>
                </Alert>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Not observed yet.</p>
          )}
        </CardContent>
      </Card>

      <Card className="py-0">
        <CardHeader className="px-5 pt-5">
          <CardTitle>History</CardTitle>
          <CardDescription>Source observations, observed values, and findings over time.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-5">Observed at</TableHead>
                <TableHead>Collection</TableHead>
                <TableHead>Observed value</TableHead>
                <TableHead>State</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...d.history].reverse().map((h) => (
                <TableRow key={h.observation_id}>
                  <TableCell className="pl-5 whitespace-nowrap text-muted-foreground">{formatDateTime(h.completed_at)}</TableCell>
                  <TableCell className="text-muted-foreground">{sentenceCase(h.collection_state)}</TableCell>
                  <TableCell className="font-medium">{h.extracted_value ?? "—"}</TableCell>
                  <TableCell>
                    <RepresentationStateBadge state={h.state} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>AI citations</CardTitle>
          <CardDescription>AI answers that referenced this source.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
            Citation shows that the source was referenced in this observation. It does not prove the source caused the answer.
          </p>
          {d.citations.length === 0 ? (
            <p className="text-sm text-muted-foreground">No AI answer has cited this source yet.</p>
          ) : (
            <ul className="space-y-3">
              {d.citations.map((c) => (
                <li key={`${c.observation_id}-${c.uri}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3">
                  <MessageSquareQuoteIcon className="size-4 text-muted-foreground" />
                  <span className="text-sm">
                    Seen on <span className="font-medium">{sentenceCase(c.provider)}</span>
                    {c.observed_model ? <span> ({c.observed_model})</span> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(c.collected_at)}</span>
                  <Button asChild variant="ghost" size="sm" className="ml-auto">
                    <Link to={`/observations/${c.observation_id}`}>Open answer</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card className="shadow-(--float-shadow)">
        <CardHeader>
          <CardTitle>Technical details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-muted-foreground">Extractor</dt>
            <dd className="font-mono text-xs">
              {d.binding.extractorKind} {d.binding.extractorSelector}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Comparator</dt>
            <dd className="font-mono text-xs">{d.binding.comparator}</dd>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function domainOf(url: string) {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

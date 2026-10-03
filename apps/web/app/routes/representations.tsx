import { useMemo, useState } from "react"
import { Link, useParams } from "react-router"
import { ExternalLinkIcon, GlobeIcon, ScanSearchIcon, TriangleAlertIcon } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState, PageHeader } from "@/components/page"
import { ControlBadge, RepresentationStateBadge } from "@/components/status"
import { Representations, type RepresentationRow } from "@/lib/api"
import { formatDateTime, sentenceCase } from "@/lib/format"
import { representationFilterLabels, representationFilters, type RepresentationFilter } from "@/lib/nav"
import { useApi } from "@/lib/use-api"

const domainOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function RepresentationsPage() {
  const { id = "" } = useParams()
  const { data, loading } = useApi(`representations:${id}`, () => Representations.list(id))
  const [filter, setFilter] = useState<RepresentationFilter>("ALL")

  const rows = useMemo(() => data?.representations ?? [], [data])
  const counts = useMemo(() => {
    const c: Record<RepresentationFilter, number> = { ALL: rows.length, IN_SYNC: 0, DRIFT: 0, UNKNOWN: 0 }
    for (const r of rows) {
      const s = r.finding.state as RepresentationFilter
      if (s === "IN_SYNC" || s === "DRIFT" || s === "UNKNOWN") c[s] += 1
    }
    return c
  }, [rows])
  const visible = filter === "ALL" ? rows : rows.filter((r) => r.finding.state === filter)

  return (
    <div className="space-y-6">
      <PageHeader
        title="Representations"
        description="Where approved facts have been observed on websites and other known sources."
        actions={
          <Button asChild variant="outline">
            <Link to={`/businesses/${id}/representations/discovery`}>
              <ScanSearchIcon />
              Discover sources
            </Link>
          </Button>
        }
      />

      <Tabs value={filter} onValueChange={(v) => setFilter(v as RepresentationFilter)}>
        <TabsList>
          {representationFilters.map((f) => (
            <TabsTrigger key={f} value={f}>
              {representationFilterLabels[f]}
              <span className="rounded bg-muted px-1.5 text-xs tabular-nums text-muted-foreground in-data-[state=active]:bg-secondary">
                {counts[f]}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {loading ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<GlobeIcon />}
          title="No tracked representations yet"
          description="Configure source bindings for your approved facts to watch where they appear. An empty list does not mean everything is in sync."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<GlobeIcon />}
          title={`No ${representationFilterLabels[filter].toLowerCase()} representations`}
          description="Switch to another filter to see the rest."
        />
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-5">Approved fact</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Observed value</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Last checked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <RepresentationTableRow key={r.binding_id} businessId={id} row={r} />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function RepresentationTableRow({ businessId, row: r }: { businessId: string; row: RepresentationRow }) {
  const failedLatest = r.latest_attempt?.collection_state === "FAILED"
  const effectiveFailed = r.effective_observation === null
  return (
    <TableRow>
      <TableCell className="pl-5">
        <Link to={`/businesses/${businessId}/truth`} className="font-medium hover:underline">
          {sentenceCase(r.fact.predicate)}
        </Link>
        <div className="text-xs text-muted-foreground">{r.fact.valueText}</div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <a href={r.source.url} target="_blank" rel="noreferrer" className="inline-flex max-w-56 items-center gap-1 truncate hover:underline">
            <span className="truncate">{domainOf(r.source.url)}</span>
            <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" />
          </a>
          <ControlBadge control={r.source.control} />
        </div>
      </TableCell>
      <TableCell>
        {r.effective_observation ? (
          <span className="font-medium">{r.effective_observation.extracted_value ?? "—"}</span>
        ) : (
          <span className="text-muted-foreground">Not observed yet</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1.5">
          <Link to={`/businesses/${businessId}/representations/${r.binding_id}`} aria-label={`Open representation for ${sentenceCase(r.fact.predicate)}`}>
            <RepresentationStateBadge state={r.finding.state} />
          </Link>
          {failedLatest && !effectiveFailed ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <TriangleAlertIcon className="size-3" />
              Latest check failed
            </span>
          ) : null}
        </div>
      </TableCell>
      <TableCell className="whitespace-nowrap text-muted-foreground">
        {r.latest_attempt ? formatDateTime(r.latest_attempt.completed_at) : <span>Never</span>}
      </TableCell>
    </TableRow>
  )
}

export function domainLabel(url: string): string {
  return domainOf(url)
}

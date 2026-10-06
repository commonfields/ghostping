import { Link, useParams } from "react-router"
import { ArrowLeftIcon, TriangleAlertIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeader } from "@/components/page"
import { Search } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

export function SiteRunPage() {
  const { id = "", siteId = "", runId = "" } = useParams()
  const detail = useApi(`site-run:${runId}`, () => Search.getRun(id, siteId, runId))
  const run = detail.data?.run ?? null
  const observations = (detail.data?.observations ?? []) as Array<Record<string, unknown>>
  const events = (detail.data?.events ?? []) as Array<{ kind: string }>

  return (
    <div className="space-y-6">
      <PageHeader
        title="Inspection evidence"
        description={run ? `Queued ${formatDateTime(run.queuedAt)}${run.completedAt ? ` · finished ${formatDateTime(run.completedAt)}` : ""}` : "Loading the inspection record."}
        actions={
          <Button asChild variant="outline">
            <Link to={`/businesses/${id}/search`}>
              <ArrowLeftIcon />
              Search
            </Link>
          </Button>
        }
      />
      {detail.loading || !run ? <Skeleton className="h-40" /> : (
        <>
          <Card className="shadow-(--float-shadow)">
            <CardHeader>
              <CardTitle>Run {run.state.toLowerCase().replace(/_/g, " ")}</CardTitle>
              <CardDescription>
                {run.urlsInspected} URLs inspected · {run.urlsFailed} failed · {run.findingsProduced} problems recorded.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {run.state === "PARTIALLY_SUCCEEDED" ? (
                <Alert>
                  <TriangleAlertIcon />
                  <AlertTitle className="font-normal">Inspection incomplete</AlertTitle>
                  <AlertDescription>Some URLs could not be inspected. Listed problems reflect what was reached, not the whole site.</AlertDescription>
                </Alert>
              ) : null}
              {run.state === "FAILED" ? (
                <Alert variant="destructive">
                  <TriangleAlertIcon />
                  <AlertTitle className="font-normal">Inspection failed</AlertTitle>
                  <AlertDescription>{run.failureDetailSafe ?? run.failureClass ?? "No evidence was collected."}</AlertDescription>
                </Alert>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Inspected URLs</CardTitle>
              <CardDescription>Raw per-URL evidence: status, indexability, and digests.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y rounded-lg border">
                {observations.map((o) => (
                  <li key={String(o["id"])} className="px-4 py-3 text-sm">
                    <p className="break-all font-medium">{String(o["finalUrl"] ?? o["url"])}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Status {String(o["httpStatus"] ?? "—")} · {String(o["indexability"] ?? "UNKNOWN")} · {String(o["collectionState"] ?? "")}
                      {o["bodyDigest"] ? ` · digest ${(String(o["bodyDigest"]) as string).slice(0, 12)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Operational events</CardTitle>
              <CardDescription>Structured run history without secrets or page bodies.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm text-muted-foreground">
                {events.map((e, i) => (
                  <li key={i} className="font-mono text-xs">{e.kind}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

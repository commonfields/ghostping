import { useMemo, useState } from "react"
import { useParams } from "react-router"
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
import { Card, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EmptyState, PageHeader } from "@/components/page"
import { FactStatusBadge } from "@/components/status"
import { Facts, type Fact } from "@/lib/api"
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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Truth"
        description="The facts this business stands behind. Ghostping compares source and AI representations against these versions."
        actions={
          repositoryManaged ? null : (
            <Button onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Add fact
            </Button>
          )
        }
      />

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-4">
          <span className="text-sm font-medium">Authority</span>
          {repositoryManaged ? (
            <Badge variant="secondary">Managed by repository manifest</Badge>
          ) : (
            <Badge variant="supported">Managed in Ghostping</Badge>
          )}
          <span className="text-sm text-muted-foreground tabular-nums">
            {activeCount} active {activeCount === 1 ? "fact" : "facts"}
          </span>
        </CardContent>
      </Card>

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
              The highlighted rows are both active for the same period. Ghostping does not pick a winner. Supersede or retire one of them so
              reviews have a single source of truth.
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={view} onValueChange={(v) => setView(v as "active" | "all")}>
        <TabsList>
          <TabsTrigger value="active">
            Active
            <span className="rounded bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{activeCount}</span>
          </TabsTrigger>
          <TabsTrigger value="all">
            All versions
            <span className="rounded bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">{facts.length}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

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
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-5">Fact</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Provenance</TableHead>
                  <TableHead className="w-12 pr-5">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((f) => {
                  const conflict = conflictIds.has(f.id)
                  const prov = provenanceOf(f.id)
                  return (
                    <TableRow key={f.id} className={cn(conflict && "bg-wrong-soft/70 hover:bg-wrong-soft")}>
                      <TableCell className="pl-5">
                        <div className="font-medium">{sentenceCase(f.predicate)}</div>
                        <div className="text-xs text-muted-foreground">{f.subject}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{f.valueText}</span>
                          {conflict ? (
                            <Badge variant="wrong">
                              <TriangleAlertIcon />
                              Conflict
                            </Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{sentenceCase(f.valueType)}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <FactStatusBadge status={f.status} />
                          <span className="text-xs text-muted-foreground tabular-nums">v{f.version}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {prov ? (
                          <span>
                            Manifest key <span className="font-medium text-foreground">{prov.manifestKey}</span>
                          </span>
                        ) : (
                          <span>Entered by hand</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${sentenceCase(f.predicate)}`}>
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
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
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
                  <span className="text-sm font-medium">{h.valueText}</span>
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
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
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

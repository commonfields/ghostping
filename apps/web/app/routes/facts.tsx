import { useMemo, useState } from "react"
import { useParams } from "react-router"
import { toast } from "sonner"
import { ArchiveIcon, BookCheckIcon, EllipsisIcon, GitBranchPlusIcon, PlusIcon, TriangleAlertIcon } from "lucide-react"
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { EmptyState, PageHeader } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { FactStatusBadge } from "@/components/status"
import { Facts, type Fact } from "@/lib/api"
import { errorMessage, formatDate, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

const valueTypes = ["TEXT", "NUMBER", "CURRENCY", "BOOLEAN", "DATE", "URL", "ENUM"] as const
const sourceKinds = ["MANUAL", "WEBSITE", "PRODUCT_CATALOG", "POLICY_DOCUMENT", "OTHER"] as const

export function FactsPage() {
  const { id = "" } = useParams()
  const { data, loading, reload } = useApi(`facts:${id}`, () => Facts.list(id))
  const [view, setView] = useState<"active" | "all">("active")
  const [addOpen, setAddOpen] = useState(false)
  const [superseding, setSuperseding] = useState<Fact | null>(null)
  const [retiring, setRetiring] = useState<Fact | null>(null)

  const facts = useMemo(() => data?.facts ?? [], [data])
  const conflicts = useMemo(() => data?.conflicts ?? [], [data])
  const conflictIds = useMemo(() => new Set(conflicts.flatMap((c) => [c.a, c.b])), [conflicts])
  const activeCount = facts.filter((f) => f.status === "ACTIVE").length
  const visible = view === "active" ? facts.filter((f) => f.status === "ACTIVE") : facts

  return (
    <div className="space-y-6">
      <PageHeader
        title="Approved facts"
        description="The statements you stand behind. Ghostping compares AI answers against these. Changing a value creates a new version, so earlier verdicts keep their history."
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <PlusIcon />
            Add fact
          </Button>
        }
      />

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
            <Button onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Add fact
            </Button>
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
                  <TableHead>Valid from</TableHead>
                  <TableHead className="w-12 pr-5">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((f) => {
                  const conflict = conflictIds.has(f.id)
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
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDate(f.validFrom)}
                        {f.validUntil ? <span> to {formatDate(f.validUntil)}</span> : null}
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        {f.status === "ACTIVE" ? (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${sentenceCase(f.predicate)}`}>
                                <EllipsisIcon />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem onSelect={() => setSuperseding(f)}>
                                <GitBranchPlusIcon />
                                New version
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem variant="destructive" onSelect={() => setRetiring(f)}>
                                <ArchiveIcon className="text-destructive" />
                                Retire fact
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        ) : null}
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

function FactDialog({
  businessId,
  fact,
  open,
  onOpenChange,
  onSaved,
}: {
  businessId: string
  fact?: Fact | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const superseding = Boolean(fact)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <FactForm
            key={fact?.id ?? "new"}
            businessId={businessId}
            fact={fact ?? null}
            superseding={superseding}
            onCancel={() => onOpenChange(false)}
            onSaved={() => {
              onSaved()
              onOpenChange(false)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function FactForm({
  businessId,
  fact,
  superseding,
  onCancel,
  onSaved,
}: {
  businessId: string
  fact: Fact | null
  superseding: boolean
  onCancel: () => void
  onSaved: () => void
}) {
  const [subject, setSubject] = useState(fact?.subject ?? "")
  const [predicate, setPredicate] = useState(fact?.predicate ?? "")
  const [valueText, setValueText] = useState(fact?.valueText ?? "")
  const [valueType, setValueType] = useState<string>(fact?.valueType ?? "TEXT")
  const [sourceKind, setSourceKind] = useState<string>("MANUAL")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSave = valueText.trim() && (superseding || (subject.trim() && predicate.trim()))

  return (
    <form
      className="grid gap-5"
      onSubmit={(e) => {
        e.preventDefault()
        setPending(true)
        setError(null)
        const validFrom = new Date().toISOString()
        const call =
          superseding && fact
            ? Facts.supersede(businessId, fact.id, { valueText, valueType, validFrom, sourceKind })
            : Facts.create(businessId, { subject, predicate: predicate.trim().replace(/\s+/g, "_").toLowerCase(), valueText, valueType, validFrom, sourceKind })
        call
          .then(() => {
            toast.success(superseding ? "New version saved" : "Fact added")
            onSaved()
          })
          .catch((err: unknown) => setError(errorMessage(err)))
          .finally(() => setPending(false))
      }}
    >
      <DialogHeader>
        <DialogTitle>{superseding ? "New version" : "Add approved fact"}</DialogTitle>
        <DialogDescription>
          {superseding && fact
            ? `Replaces v${fact.version} of ${sentenceCase(fact.predicate).toLowerCase()} from today. The current value stays in history.`
            : "Facts take effect from today. Use a short, stable name so reviews can find it later."}
        </DialogDescription>
      </DialogHeader>

      {superseding ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="f-subject">Subject</Label>
            <Input id="f-subject" autoFocus value={subject} onChange={(e) => setSubject(e.currentTarget.value)} placeholder="northstar" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="f-predicate">Fact name</Label>
            <Input id="f-predicate" value={predicate} onChange={(e) => setPredicate(e.currentTarget.value)} placeholder="monthly price" />
          </div>
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="f-value">Value</Label>
        <Input id="f-value" autoFocus={superseding} value={valueText} onChange={(e) => setValueText(e.currentTarget.value)} placeholder="$39" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="f-type">Value type</Label>
          <Select value={valueType} onValueChange={setValueType}>
            <SelectTrigger id="f-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {valueTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {t === "URL" ? "Link" : sentenceCase(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="f-source">Source</Label>
          <Select value={sourceKind} onValueChange={setSourceKind}>
            <SelectTrigger id="f-source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sourceKinds.map((t) => (
                <SelectItem key={t} value={t}>
                  {t === "MANUAL" ? "Entered by hand" : sentenceCase(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle className="font-normal">{error}</AlertTitle>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !canSave}>
          {pending ? <Spinner /> : null}
          {superseding ? "Save new version" : "Add fact"}
        </Button>
      </DialogFooter>
    </form>
  )
}

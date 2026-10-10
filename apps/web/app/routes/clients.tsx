// Agency workspace: the agency's clients and their shareable records.
import { useMemo, useState } from "react"
import { Link, useNavigate } from "react-router"
import { ChevronRightIcon, FileCheck2Icon, GlobeIcon, LinkIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader, Panel, StatStrip, StepFlow, domainOf } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { errorMessage, formatDate, initial, relativeTime } from "@/lib/format"
import { Records, type Engagement } from "@/lib/record"
import { useApi } from "@/lib/use-api"

const WEEK = 7 * 24 * 60 * 60 * 1000

export function ClientsPage() {
  const clients = useApi("record-clients", () => Records.list())
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const list = useMemo(() => clients.data?.clients ?? [], [clients.data])
  const visible = list.filter((c) => `${c.name} ${c.websiteUrl}`.toLowerCase().includes(q.trim().toLowerCase()))
  const now = Date.now()
  const recent = list.filter((c) => c.lastCheckedAt && now - new Date(c.lastCheckedAt).getTime() < WEEK).length
  const never = list.filter((c) => !c.lastCheckedAt).length
  const shared = list.filter((c) => c.hasActiveShare).length

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Clients"
        description="One shareable record per client: three approved facts, what a live AI surface said about them, your review, and the weekly re-check."
        actions={
          <Button size="sm" onClick={() => setOpen(true)}>
            <PlusIcon />
            New client
          </Button>
        }
      />

      {list.length > 0 ? (
      <StatStrip
        stats={[
          { key: "all", label: "Clients", value: clients.loading ? <Skeleton className="h-5 w-8" /> : list.length, hint: "Records you operate" },
          { key: "recent", label: "Checked this week", value: clients.loading ? <Skeleton className="h-5 w-8" /> : recent, hint: "Last check under 7 days ago", tone: "supported" },
          { key: "never", label: "Never checked", value: clients.loading ? <Skeleton className="h-5 w-8" /> : never, hint: "Run the first check", tone: "review" },
          { key: "shared", label: "Shared", value: clients.loading ? <Skeleton className="h-5 w-8" /> : shared, hint: "Active share link" },
        ]}
      />
      ) : null}

      {clients.loading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : clients.error ? (
        <EmptyState icon={<TriangleAlertIcon />} title="Clients could not load" description={errorMessage(clients.error)} action={<Button variant="outline" size="sm" onClick={() => void clients.reload()}>Try again</Button>} />
      ) : list.length === 0 ? (
        <Panel>
          <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center">
            <div className="space-y-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <FileCheck2Icon className="size-4" />
              </span>
              <h2 className="text-sm font-medium">A record you can hand to the client</h2>
              <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                Agree three facts with the client, ask a live AI surface the question a buyer would ask about each, judge every answer yourself, then share a read-only link.
                The weekly re-check shows whether the answers changed after your work.
              </p>
              <Button size="sm" onClick={() => setOpen(true)}>
                <PlusIcon />
                Add your first client
              </Button>
            </div>
            <StepFlow
              className="lg:grid-cols-2"
              steps={[
                { key: "add", label: "Add the client", hint: "Name and website", state: "current" },
                { key: "facts", label: "Approve three facts", hint: "One buyer question each", state: "todo" },
                { key: "check", label: "Check the live surface", hint: "Then review every answer", state: "todo" },
                { key: "share", label: "Share and re-check", hint: "Read-only link, weekly comparison", state: "todo" },
              ]}
            />
          </div>
        </Panel>
      ) : (
        <Panel>
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Search clients" aria-label="Search clients" className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="hidden grid-cols-[minmax(0,1fr)_9rem_9rem_1rem] gap-4 border-y bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground sm:grid">
            <span>Client</span>
            <span>Last checked</span>
            <span>Share</span>
            <span />
          </div>
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">No client matches &ldquo;{q}&rdquo;.</p>
          ) : (
            <ul className="divide-y">
              {visible.map((c) => (
                <li key={c.businessId}>
                  <Link
                    to={`/clients/${c.businessId}`}
                    className="grid items-center gap-x-4 gap-y-1 px-4 py-2.5 text-xs transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_1rem]"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">{initial(c.name)}</span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">{c.name}</span>
                          {c.engagement !== "CLIENT" ? <Badge variant="outline">{c.engagement === "DOGFOOD" ? "Dogfood" : "Fixture"}</Badge> : null}
                        </span>
                        <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
                          <GlobeIcon className="size-3" />
                          {domainOf(c.websiteUrl)}
                        </span>
                      </span>
                    </span>
                    <span className="text-muted-foreground" title={c.lastCheckedAt ? formatDate(c.lastCheckedAt) : undefined}>
                      {c.lastCheckedAt ? `Last checked ${relativeTime(c.lastCheckedAt)}` : <span className="text-review">Never checked</span>}
                    </span>
                    <span>
                      {c.hasActiveShare ? (
                        <Badge variant="supported">
                          <LinkIcon />
                          Share link active
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">Not shared</span>
                      )}
                    </span>
                    <ChevronRightIcon className="hidden size-4 text-muted-foreground sm:block" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}

      <NewClientDialog open={open} onOpenChange={setOpen} />
    </div>
  )
}

function NewClientDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const nav = useNavigate()
  const [name, setName] = useState("")
  const [website, setWebsite] = useState("https://")
  const [engagement, setEngagement] = useState<Engagement>("CLIENT")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { client } = await Records.create({ name: name.trim(), websiteUrl: website.trim(), engagement })
      onOpenChange(false)
      nav(`/clients/${client.businessId}`)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
          <DialogDescription>Next you approve three facts with the client and run the first check.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="client-name">Client name</Label>
            <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="client-site">Website</Label>
            <Input id="client-site" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={2000} required />
          </div>
          <div className="grid gap-2">
            <Label>Engagement</Label>
            <Select value={engagement} onValueChange={(v) => setEngagement(v as Engagement)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CLIENT">Client engagement</SelectItem>
                <SelectItem value="DOGFOOD">Dogfood (a site you control; not customer validation)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? <Spinner /> : null}
              Create client
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

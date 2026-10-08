// Agency workspace: the agency's clients and their shareable records.
import { useState } from "react"
import { Link, useNavigate } from "react-router"
import { FileCheck2Icon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { EmptyState, PageHeader } from "@/components/page"
import { Skeleton } from "@/components/ui/skeleton"
import { errorMessage, formatDate } from "@/lib/format"
import { Records, type Engagement } from "@/lib/record"
import { useApi } from "@/lib/use-api"

export function ClientsPage() {
  const clients = useApi("record-clients", () => Records.list())
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [website, setWebsite] = useState("https://")
  const [engagement, setEngagement] = useState<Engagement>("CLIENT")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true); setError(null)
    try {
      const { client } = await Records.create({ name: name.trim(), websiteUrl: website.trim(), engagement })
      nav(`/clients/${client.businessId}`)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-8">
      <PageHeader title="Clients" description="One shareable record per client: three approved facts, what a live AI surface said about them, your review, and the weekly re-check."
        actions={<Button onClick={() => setOpen(o => !o)}><PlusIcon />New client</Button>} />
      {open ? (
        <form className="grid max-w-xl gap-4 rounded-xl border p-5" onSubmit={e => { e.preventDefault(); void create() }}>
          <div className="grid gap-2"><Label htmlFor="client-name">Client name</Label><Input id="client-name" value={name} onChange={e => setName(e.target.value)} maxLength={200} required /></div>
          <div className="grid gap-2"><Label htmlFor="client-site">Website</Label><Input id="client-site" type="url" value={website} onChange={e => setWebsite(e.target.value)} maxLength={2000} required /></div>
          <div className="grid gap-2">
            <Label>Engagement</Label>
            <Select value={engagement} onValueChange={v => setEngagement(v as Engagement)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="CLIENT">Client engagement</SelectItem>
                <SelectItem value="DOGFOOD">Dogfood (a site you control; not customer validation)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <div><Button type="submit" disabled={busy || !name.trim()}>Create client</Button></div>
        </form>
      ) : null}
      {clients.loading ? <Skeleton className="h-32 rounded-xl" /> : (clients.data?.clients.length ?? 0) === 0 ? (
        <EmptyState icon={<FileCheck2Icon />} title="No clients yet" description="Add a client, approve three facts with them, and run the first check." />
      ) : (
        <ul className="divide-y rounded-xl border">
          {clients.data!.clients.map(c => (
            <li key={c.businessId}>
              <Link className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 hover:bg-muted/50" to={`/clients/${c.businessId}`}>
                <span className="font-medium">{c.name}{c.engagement !== "CLIENT" ? <span className="ml-2 rounded border px-1.5 text-xs text-muted-foreground">{c.engagement}</span> : null}</span>
                <span className="text-sm text-muted-foreground">Last checked {formatDate(c.lastCheckedAt)} · {c.hasActiveShare ? "Share link active" : "Not shared"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

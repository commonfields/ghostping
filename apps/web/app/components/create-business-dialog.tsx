import { useState } from "react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/spinner"
import { Businesses } from "@/lib/api"
import { errorMessage } from "@/lib/format"
import { useWorkspace } from "@/lib/workspace"

export function CreateBusinessDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { reloadBusinesses } = useWorkspace()
  const nav = useNavigate()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) {
          setName("")
          setError(null)
        }
      }}
    >
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            setPending(true)
            setError(null)
            Businesses.create(name)
              .then(async (r) => {
                await reloadBusinesses()
                onOpenChange(false)
                setName("")
                toast.success(`Created ${r.business.name}`)
                nav(`/businesses/${r.business.id}/overview`)
              })
              .catch((err: unknown) => setError(errorMessage(err)))
              .finally(() => setPending(false))
          }}
        >
          <DialogHeader>
            <DialogTitle>New business</DialogTitle>
            <DialogDescription>Each business has its own approved facts, buyer questions and issues.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="business-name">Business name</Label>
            <Input id="business-name" autoFocus value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Northstar Software" />
            {error ? <p className="text-sm text-wrong">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? <Spinner /> : null}
              Create business
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

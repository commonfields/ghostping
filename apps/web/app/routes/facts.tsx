import { useState } from "react"
import { Navigate } from "react-router"
import { toast } from "sonner"
import { TriangleAlertIcon } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/spinner"
import { Facts, type Fact } from "@/lib/api"
import { errorMessage, sentenceCase } from "@/lib/format"

const valueTypes = ["TEXT", "NUMBER", "CURRENCY", "BOOLEAN", "DATE", "URL", "ENUM"] as const
const sourceKinds = ["MANUAL", "WEBSITE", "PRODUCT_CATALOG", "POLICY_DOCUMENT", "OTHER"] as const

export function FactsPage() {
  // Legacy URL: /facts now renders as Truth. Kept so existing deep links
  // and bookmarks keep working.
  return <Navigate to="../truth" replace />
}

export function FactDialog({
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

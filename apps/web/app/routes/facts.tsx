import { useEffect, useState } from "react"
import { useParams } from "react-router"
import { Facts } from "../lib/api.js"

type Fact = {
  id: string
  subject: string
  predicate: string
  valueText: string
  valueType: string
  status: string
  version: number
  validFrom: string
  validUntil: string | null
}

export function FactsPage() {
  const { id = "" } = useParams()
  const [facts, setFacts] = useState<Fact[]>([])
  const [conflicts, setConflicts] = useState<Array<{ a: string; b: string }>>([])
  const [form, setForm] = useState({ subject: "northstar", predicate: "monthly_price", valueText: "$39", valueType: "CURRENCY" })
  const reload = () => Facts.list(id).then((r) => { setFacts(r.facts as Fact[]); setConflicts(r.conflicts) }).catch(() => undefined)
  useEffect(() => { reload() }, [id])
  const conflictIds = new Set(conflicts.flatMap((c) => [c.a, c.b]))
  return (
    <section>
      <h1>Approved facts</h1>
      {conflicts.length > 0 ? (
        <div role="alert" style={{ border: "2px solid #b00", padding: 12, marginBottom: 12 }}>
          <h2>Pricing conflict — resolution required</h2>
          <p>Both facts below are active for the same period. Ghostping does not pick a winner automatically.</p>
        </div>
      ) : null}
      <ul>
        {facts.map((f) => (
          <li key={f.id} style={conflictIds.has(f.id) ? { border: "1px solid #b00", padding: 8 } : undefined}>
            <strong>{f.predicate}</strong> = {f.valueText} <em>({f.status} v{f.version})</em>
            {conflictIds.has(f.id) ? <span> — Both are active for the same period. Resolution required.</span> : null}
            <div>
              <button onClick={() => {
                const v = window.prompt("New value (creates a new version, never edits in place):", f.valueText)
                if (!v) return
                Facts.supersede(id, f.id, { valueText: v, valueType: f.valueType, validFrom: new Date().toISOString(), sourceKind: "MANUAL" }).then(reload)
              }}>Supersede</button>
              <button onClick={() => Facts.retire(id, f.id).then(reload)}>Retire</button>
            </div>
          </li>
        ))}
      </ul>
      <h2>Add approved fact</h2>
      <form onSubmit={(e) => {
        e.preventDefault()
        Facts.create(id, { ...form, validFrom: new Date().toISOString(), sourceKind: "MANUAL" }).then(reload)
      }}>
        <input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} placeholder="subject" />
        <input value={form.predicate} onChange={(e) => setForm({ ...form, predicate: e.target.value })} placeholder="predicate" />
        <input value={form.valueText} onChange={(e) => setForm({ ...form, valueText: e.target.value })} placeholder="value" />
        <select value={form.valueType} onChange={(e) => setForm({ ...form, valueType: e.target.value })}>
          {["TEXT","NUMBER","CURRENCY","BOOLEAN","DATE","URL","ENUM"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button type="submit">Add fact</button>
      </form>
    </section>
  )
}

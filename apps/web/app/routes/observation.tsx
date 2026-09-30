import { useCallback, useEffect, useState } from "react"
import { useParams, Link } from "react-router"
import { Observations, Claims, Judgments, Facts } from "../lib/api.js"

type Obs = {
  id: string
  business_id: string
  answer_text: string
  provider: string
  observed_model: string | null
  collected_at: string
}

export function ObservationPage() {
  const { observationId = "" } = useParams()
  const [observation, setObservation] = useState<Obs | null>(null)
  const [claims, setClaims] = useState<Array<{ id: string; text: string }>>([])
  const [claimText, setClaimText] = useState("Northstar costs $29/month.")
  const [facts, setFacts] = useState<Array<{ id: string; predicate: string; valueText: string }>>([])
  const reload = useCallback(() => {
    Observations.get(observationId).then((r) => {
      const o = r.observation as unknown as Obs
      setObservation(o)
      setClaims(r.claims)
      if (o?.business_id) {
        Facts.list(o.business_id).then((f) => setFacts((f.facts as Array<{ id: string; predicate: string; valueText: string }>).filter((x) => (x as unknown as { status: string }).status === "ACTIVE" || true))).catch(() => undefined)
      }
    }).catch(() => undefined)
  }, [observationId])
  useEffect(() => { reload() }, [reload])
  return (
    <main style={{ maxWidth: 800, margin: "0 auto", fontFamily: "system-ui" }}>
      <Link to="/">← Back</Link>
      <h1>AI answer</h1>
      {observation ? (
        <>
          <blockquote>{observation.answer_text}</blockquote>
          <p>Seen on: {observation.provider} {observation.observed_model ?? ""}</p>
        </>
      ) : <p>Loading…</p>}
      <h2>Create factual claim</h2>
      <form onSubmit={(e) => {
        e.preventDefault()
        Claims.create(observationId, claimText).then(reload)
      }}>
        <input value={claimText} onChange={(e) => setClaimText(e.currentTarget.value)} style={{ width: 420 }} />
        <button type="submit">Save claim</button>
      </form>
      <h2>Claims</h2>
      <ul>
        {claims.map((c) => (
          <li key={c.id}>
            {c.text}
            <ClaimReview claimId={c.id} facts={facts} />
          </li>
        ))}
      </ul>
    </main>
  )
}

function ClaimReview(props: { claimId: string; facts: Array<{ id: string; predicate: string; valueText: string }> }) {
  const [verdict, setVerdict] = useState("CONTRADICTED")
  const [notes, setNotes] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  return (
    <form onSubmit={(e) => {
      e.preventDefault()
      Judgments.create(props.claimId, verdict, selected, notes).then(() => window.alert("Judgment recorded — check the Issues inbox"))
    }}>
      <p>Approved facts (select the ones this claim contradicts or supports):</p>
      <ul>
        {props.facts.map((f) => (
          <li key={f.id}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(f.id)}
                onChange={(e) => setSelected(e.currentTarget.checked ? [...selected, f.id] : selected.filter((s) => s !== f.id))}
              />
              {f.predicate} = {f.valueText}
            </label>
          </li>
        ))}
      </ul>
      <div>
        {(["SUPPORTED", "CONTRADICTED", "PARTIAL", "INSUFFICIENT_EVIDENCE"] as const).map((v) => (
          <label key={v} style={{ marginRight: 12 }}>
            <input type="radio" name={`verdict-${props.claimId}`} checked={verdict === v} onChange={() => setVerdict(v)} />
            {v === "CONTRADICTED" ? "Wrong" : v === "PARTIAL" ? "Partially correct" : v === "INSUFFICIENT_EVIDENCE" ? "Not enough information" : "Supported"}
          </label>
        ))}
      </div>
      <input value={notes} onChange={(e) => setNotes(e.currentTarget.value)} placeholder="Notes" />
      <button type="submit">Record judgment</button>
    </form>
  )
}

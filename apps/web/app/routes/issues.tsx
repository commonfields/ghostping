import { useEffect, useState } from "react"
import { Link, useParams } from "react-router"
import { Issues } from "../lib/api.js"

type Issue = {
  claim_id: string
  claim_text: string
  state: string
  verdict: string | null
  answer_text: string
  provider: string
  question_prompt: string
  facts: Array<{ predicate: string; valueText: string }>
  observation_id: string
  collected_at: string
}

export function IssuesPage() {
  const { id = "" } = useParams()
  const [issues, setIssues] = useState<Issue[]>([])
  useEffect(() => {
    Issues.list(id).then((r) => setIssues(r.issues as Issue[])).catch(() => undefined)
  }, [id])
  return (
    <section>
      <h1>Issues</h1>
      {issues.length === 0 ? <p>No issues need attention. Supported answers stay out of this inbox.</p> : null}
      <ul>
        {issues.map((i) => (
          <li key={i.claim_id} style={{ border: "1px solid #999", padding: 12, marginBottom: 12 }}>
            <strong>{i.state === "WRONG" ? "WRONG" : i.state === "PARTIAL" ? "PARTIALLY CORRECT" : i.state === "UNKNOWN" ? "UNKNOWN" : "NEEDS REVIEW"}</strong>
            <p>AI said: {i.claim_text}</p>
            {i.facts.map((f) => (
              <p key={f.predicate}>Your approved fact ({f.predicate}): {f.valueText}</p>
            ))}
            <p>Seen on: {i.provider}</p>
            <p>Question: {i.question_prompt}</p>
            <p>Checked: {i.collected_at ? new Date(i.collected_at).toDateString() : ""}</p>
            <Link to={`/observations/${i.observation_id}`}>Open provenance</Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

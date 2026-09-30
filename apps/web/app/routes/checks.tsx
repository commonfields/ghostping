import { useEffect, useState } from "react"
import { Link, useParams } from "react-router"
import { Questions, Checks } from "../lib/api.js"

export function ChecksPage() {
  const { id = "" } = useParams()
  const [questions, setQuestions] = useState<Array<{ id: string; prompt: string }>>([])
  const [runs, setRuns] = useState<Array<{ id: string; status: string; provider: string; observationId: string | null }>>([])
  const [prompt, setPrompt] = useState("How much does Northstar cost?")
  const reload = () => {
    Questions.list(id).then((r) => setQuestions(r.questions)).catch(() => undefined)
    Checks.list(id).then((r) => setRuns(r.checkRuns)).catch(() => undefined)
  }
  useEffect(() => { reload(); const t = setInterval(reload, 2000); return () => clearInterval(t) }, [id])
  return (
    <section>
      <h1>Checks</h1>
      <h2>Buyer questions</h2>
      <ul>
        {questions.map((q) => (
          <li key={q.id}>
            {q.prompt}
            <button onClick={() => Checks.run(id, q.id).then(reload)}>Run check</button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => { e.preventDefault(); Questions.create(id, prompt).then(reload) }}>
        <input value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} style={{ width: 360 }} />
        <button type="submit">Add question</button>
      </form>
      <h2>Run history</h2>
      <ul>
        {runs.map((r) => (
          <li key={r.id}>
            {r.status} via {r.provider}{" "}
            {r.observationId ? <Link to={`/observations/${r.observationId}`}>View AI answer</Link> : "(waiting for worker…)"}
          </li>
        ))}
      </ul>
    </section>
  )
}

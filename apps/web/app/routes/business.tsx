import { useEffect, useState } from "react"
import { Link, Outlet, useParams } from "react-router"
import { Issues } from "../lib/api.js"

export function BusinessLayout() {
  const { id = "" } = useParams()
  return (
    <main style={{ maxWidth: 900, margin: "0 auto", fontFamily: "system-ui" }}>
      <nav style={{ display: "flex", gap: 16, borderBottom: "1px solid #ccc", padding: "12px 0" }}>
        <Link to={`/businesses/${id}/overview`}>Overview</Link>
        <Link to={`/businesses/${id}/facts`}>Approved facts</Link>
        <Link to={`/businesses/${id}/checks`}>Checks</Link>
        <Link to={`/businesses/${id}/issues`}>Issues</Link>
        <Link to="/">All businesses</Link>
      </nav>
      <Outlet />
    </main>
  )
}

export function Overview() {
  const { id = "" } = useParams()
  const [overview, setOverview] = useState<{ completed: string; last_checked: string | null; unreviewed: string; needs_attention: string } | null>(null)
  const [recent, setRecent] = useState<Array<{ claim_id: string; claim_text: string; state: string }>>([])
  useEffect(() => {
    Issues.overview(id).then((r) => setOverview(r.overview)).catch(() => undefined)
    Issues.list(id).then((r) => setRecent(r.issues.slice(0, 5))).catch(() => undefined)
  }, [id])
  return (
    <section>
      <h1>Overview</h1>
      {overview ? (
        <dl>
          <dt>Needs attention</dt><dd>{overview.needs_attention}</dd>
          <dt>Unreviewed</dt><dd>{overview.unreviewed}</dd>
          <dt>Checks completed</dt><dd>{overview.completed}</dd>
          <dt>Last checked</dt><dd>{overview.last_checked ?? "never"}</dd>
        </dl>
      ) : <p>Loading…</p>}
      <h2>Recent issues</h2>
      <ul>
        {recent.map((i) => (
          <li key={i.claim_id}><strong>{i.state}</strong> — {i.claim_text}</li>
        ))}
      </ul>
    </section>
  )
}

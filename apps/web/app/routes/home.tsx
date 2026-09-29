import { useEffect, useState } from "react"
import { Link, useNavigate } from "react-router"
import { Businesses, Auth } from "../lib/api.js"

export function Home() {
  const [businesses, setBusinesses] = useState<Array<{ id: string; name: string }>>([])
  const [name, setName] = useState("Northstar Software")
  const nav = useNavigate()
  useEffect(() => {
    Businesses.list().then((r) => setBusinesses(r.businesses)).catch(() => undefined)
  }, [])
  return (
    <main style={{ maxWidth: 720, margin: "2rem auto", fontFamily: "system-ui" }}>
      <header style={{ display: "flex", justifyContent: "space-between" }}>
        <h1>Ghostping</h1>
        <button
          onClick={() => Auth.signout().then(() => nav("/signin"))}
        >
          Sign out
        </button>
      </header>
      <p>See what AI systems are getting wrong about your business — with evidence.</p>
      <h2>Businesses</h2>
      <ul>
        {businesses.map((b) => (
          <li key={b.id}>
            <Link to={`/businesses/${b.id}/overview`}>{b.name}</Link>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          Businesses.create(name).then((r) => nav(`/businesses/${r.business.id}/overview`))
        }}
      >
        <input value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Business name" />
        <button type="submit">Create business</button>
      </form>
    </main>
  )
}

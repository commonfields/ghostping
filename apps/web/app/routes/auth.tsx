import { useState } from "react"
import { useNavigate, Link } from "react-router"
import { Auth } from "../lib/api.js"

export function SignIn() {
  const [email, setEmail] = useState("demo@northstar.test")
  const [password, setPassword] = useState("password123")
  const [error, setError] = useState<string | null>(null)
  const nav = useNavigate()
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>Ghostping sign in</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          Auth.signin(email, password)
            .then(() => nav("/"))
            .catch((err: Error) => setError(err.message))
        }}
      >
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} style={{ display: "block", width: "100%" }} />
        </label>
        {error ? <p style={{ color: "red" }}>{error}</p> : null}
        <button type="submit">Sign in</button>
      </form>
      <p>
        No account? <Link to="/signup">Sign up</Link>
      </p>
    </main>
  )
}

export function SignUp() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const nav = useNavigate()
  return (
    <main style={{ maxWidth: 420, margin: "4rem auto", fontFamily: "system-ui" }}>
      <h1>Create your Ghostping account</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          setError(null)
          Auth.signup(email, password)
            .then(() => nav("/"))
            .catch((err: Error) => setError(err.message))
        }}
      >
        <label>
          Email
          <input value={email} onChange={(e) => setEmail(e.currentTarget.value)} style={{ display: "block", width: "100%" }} />
        </label>
        <label>
          Password (8+ characters)
          <input type="password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} style={{ display: "block", width: "100%" }} />
        </label>
        {error ? <p style={{ color: "red" }}>{error}</p> : null}
        <button type="submit">Sign up</button>
      </form>
      <p>
        Have an account? <Link to="/signin">Sign in</Link>
      </p>
    </main>
  )
}

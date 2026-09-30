import { useEffect, useState, type ReactNode } from "react"
import { Navigate } from "react-router"
import { Auth } from "./api.js"

export function useSession(): { loading: boolean; accountId: string | null } {
  const [state, setState] = useState<{ loading: boolean; accountId: string | null }>({ loading: true, accountId: null })
  useEffect(() => {
    Auth.me()
      .then((m: { accountId: string }) => setState({ loading: false, accountId: m.accountId }))
      .catch(() => setState({ loading: false, accountId: null }))
  }, [])
  return state
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const s = useSession()
  if (s.loading) return <p>Loading…</p>
  if (!s.accountId) return <Navigate to="/signin" replace />
  return <>{children}</>
}

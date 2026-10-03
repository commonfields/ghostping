import { useEffect, useState, type ReactNode } from "react"
import { Navigate } from "react-router"
import { Auth } from "./api"
import { Spinner } from "@/components/spinner"

// TEMP: auth bypass for local dev (user cannot sign in). Set to false to re-enable.
const AUTH_DISABLED = true

export function useSession(): { loading: boolean; accountId: string | null } {
  const [state, setState] = useState<{ loading: boolean; accountId: string | null }>({ loading: !AUTH_DISABLED, accountId: AUTH_DISABLED ? "dev-local" : null })
  useEffect(() => {
    if (AUTH_DISABLED) return
    Auth.me()
      .then((m: { accountId: string }) => setState({ loading: false, accountId: m.accountId }))
      .catch(() => setState({ loading: false, accountId: null }))
  }, [])
  return state
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const s = useSession()
  if (AUTH_DISABLED) return <>{children}</>
  if (s.loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    )
  }
  if (!s.accountId) return <Navigate to="/signin" replace />
  return <>{children}</>
}

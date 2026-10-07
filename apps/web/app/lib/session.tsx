import { useEffect, useState, type ReactNode } from "react"
import { Navigate } from "react-router"
import { ApiError, Auth } from "./api"
import { Spinner } from "@/components/spinner"

export function useSession(): { loading: boolean; accountId: string | null; error: string | null } {
  const [state, setState] = useState<{ loading: boolean; accountId: string | null; error: string | null }>({
    loading: true,
    accountId: null,
    error: null,
  })
  useEffect(() => {
    Auth.me()
      .then((m: { accountId: string }) => setState({ loading: false, accountId: m.accountId, error: null }))
      .catch((e: unknown) => {
        // 401 means signed out -> redirect. Anything else is a backend
        // failure and must not masquerade as "please sign in".
        if (e instanceof ApiError && e.status === 401) {
          setState({ loading: false, accountId: null, error: null })
        } else {
          setState({ loading: false, accountId: null, error: e instanceof Error ? e.message : "Failed to reach the API" })
        }
      })
  }, [])
  return state
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const s = useSession()
  if (s.loading) {
    return (
      <div className="flex min-h-svh items-center justify-center text-muted-foreground">
        <Spinner />
      </div>
    )
  }
  if (s.error) {
    return (
      <div className="flex min-h-svh items-center justify-center text-destructive">
        Cannot reach the OpenRecord API ({s.error}). Start the API server and reload.
      </div>
    )
  }
  if (!s.accountId) return <Navigate to="/signin" replace />
  return <>{children}</>
}

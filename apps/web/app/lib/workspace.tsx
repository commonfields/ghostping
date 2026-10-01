import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { Businesses, Issues, type Business, type Overview } from "./api"

type Workspace = {
  businesses: Business[]
  businessesLoading: boolean
  reloadBusinesses: () => Promise<void>
  activeBusinessId: string | null
  setActiveBusinessId: (id: string | null) => void
  activeBusiness: Business | null
  overview: Overview | null
  reloadOverview: () => void
}

const WorkspaceContext = createContext<Workspace | null>(null)

const LAST_BUSINESS_KEY = "ghostping:last-business"

function readLastBusiness(): string | null {
  try {
    return window.localStorage.getItem(LAST_BUSINESS_KEY)
  } catch {
    return null
  }
}

function writeLastBusiness(id: string) {
  try {
    window.localStorage.setItem(LAST_BUSINESS_KEY, id)
  } catch {
    // Storage can be unavailable (private mode); remembering is a convenience only.
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [businessesLoading, setBusinessesLoading] = useState(true)
  const [activeBusinessId, setActiveId] = useState<string | null>(null)
  const [overview, setOverview] = useState<Overview | null>(null)

  const reloadBusinesses = useCallback(async () => {
    try {
      const r = await Businesses.list()
      setBusinesses(r.businesses)
    } catch {
      // Leave the previous list in place; pages surface their own errors.
    } finally {
      setBusinessesLoading(false)
    }
  }, [])

  useEffect(() => {
    void reloadBusinesses()
  }, [reloadBusinesses])

  const setActiveBusinessId = useCallback((id: string | null) => {
    setActiveId(id)
    if (id) writeLastBusiness(id)
  }, [])

  const reloadOverview = useCallback(() => {
    if (!activeBusinessId) return
    Issues.overview(activeBusinessId)
      .then((r) => setOverview(r.overview))
      .catch(() => setOverview(null))
  }, [activeBusinessId])

  useEffect(() => {
    setOverview(null)
    reloadOverview()
  }, [reloadOverview])

  const activeBusiness = useMemo(() => {
    const id = activeBusinessId ?? readLastBusiness()
    return businesses.find((b) => b.id === id) ?? null
  }, [businesses, activeBusinessId])

  const value = useMemo<Workspace>(
    () => ({
      businesses,
      businessesLoading,
      reloadBusinesses,
      activeBusinessId,
      setActiveBusinessId,
      activeBusiness,
      overview,
      reloadOverview,
    }),
    [businesses, businessesLoading, reloadBusinesses, activeBusinessId, setActiveBusinessId, activeBusiness, overview, reloadOverview],
  )

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
}

export function useWorkspace(): Workspace {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used inside WorkspaceProvider")
  return ctx
}

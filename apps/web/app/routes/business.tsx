import { useEffect, useState } from "react"
import { Link, Outlet, useParams, useSearchParams } from "react-router"
import { Building2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AgentChat } from "@/components/agent-chat"
import { EmptyState } from "@/components/page"
import { usePreferences } from "@/lib/preferences"
import { useWorkspace } from "@/lib/workspace"
import { Today } from "./today"

export function BusinessLayout() {
  const { id = "" } = useParams()
  const { setActiveBusinessId, businesses, businessesLoading } = useWorkspace()

  useEffect(() => setActiveBusinessId(id), [id, setActiveBusinessId])

  if (!businessesLoading && !businesses.some((b) => b.id === id)) {
    return (
      <EmptyState
        icon={<Building2Icon />}
        title="Business not found"
        description="It may have been removed, or it belongs to a different account."
        action={
          <Button asChild variant="outline">
            <Link to="/businesses">See all businesses</Link>
          </Button>
        }
      />
    )
  }
  return <Outlet />
}

type OverviewView = "today" | "agent"

export function Overview() {
  const { activeBusiness } = useWorkspace()
  const [params, setParams] = useSearchParams()
  const { preferences } = usePreferences()
  // ?view= wins; otherwise the landing view from settings.
  const requested = params.get("view")
  const view: OverviewView = requested === "today" || requested === "agent" ? requested : preferences.landingView
  const [chatting, setChatting] = useState(false)
  const showSwitcher = view === "today" || !chatting

  return (
    <>
      {view === "agent" ? (
        <AgentChat businessId={activeBusiness?.id ?? ""} businessName={activeBusiness?.name ?? "this business"} onConversationChange={setChatting} />
      ) : (
        <Today />
      )}
      {showSwitcher ? (
        <div className="pointer-events-none sticky bottom-5 z-20 mt-auto flex justify-center pt-8">
          <Tabs
            value={view}
            onValueChange={(v) => {
              const next = new URLSearchParams(params)
              next.set("view", v)
              setParams(next, { replace: true })
            }}
            className="pointer-events-auto"
          >
            <TabsList className="h-10 rounded-full border border-sidebar-border bg-sidebar p-1 text-sidebar-foreground shadow-(--float-shadow-strong)">
              <TabsTrigger value="agent" className="h-8 rounded-full px-4 text-xs data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-(--card-shadow)">
                Agent
              </TabsTrigger>
              <TabsTrigger value="today" className="h-8 rounded-full px-4 text-xs data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-(--card-shadow)">
                Today
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      ) : null}
    </>
  )
}

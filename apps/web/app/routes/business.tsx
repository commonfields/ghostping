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
            <Link to="/">See all businesses</Link>
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
        <AgentChat businessName={activeBusiness?.name ?? "this business"} onConversationChange={setChatting} />
      ) : (
        <Today />
      )}
      {showSwitcher ? (
        <div className="pointer-events-none sticky bottom-5 z-20 mt-auto flex justify-center pt-8">
          <Tabs
            value={view}
            onValueChange={(v) => setParams({ view: v }, { replace: true })}
            className="pointer-events-auto"
          >
            <TabsList className="h-10 rounded-full border border-sidebar-border bg-sidebar/85 p-1 text-sidebar-foreground shadow-(--float-shadow-strong) backdrop-blur supports-[backdrop-filter]:bg-sidebar/70">
              <TabsTrigger value="agent" className="rounded-full px-4 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_3px_rgb(0_0_0/0.10)]">
                Agent
              </TabsTrigger>
              <TabsTrigger value="today" className="rounded-full px-4 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-[0_1px_3px_rgb(0_0_0/0.10)]">
                Today
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      ) : null}
    </>
  )
}

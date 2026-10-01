import { useEffect, useState } from "react"
import { Link } from "react-router"
import { Building2Icon, ChevronRightIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { CreateBusinessDialog } from "@/components/create-business-dialog"
import { EmptyState, PageHeader } from "@/components/page"
import { initial } from "@/lib/format"
import { useWorkspace } from "@/lib/workspace"

export function Home() {
  const { businesses, businessesLoading, setActiveBusinessId } = useWorkspace()
  const [createOpen, setCreateOpen] = useState(false)

  useEffect(() => setActiveBusinessId(null), [setActiveBusinessId])

  return (
    <div className="space-y-8">
      <PageHeader
        title="Businesses"
        description="Pick a business to review its issues, run checks against AI assistants, and manage the facts you have approved."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <PlusIcon />
            New business
          </Button>
        }
      />

      {businessesLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[76px] rounded-xl" />
          ))}
        </div>
      ) : businesses.length === 0 ? (
        <EmptyState
          icon={<Building2Icon />}
          title="Add your first business"
          description="Ghostping compares what AI assistants say about a business with the facts you approve for it."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <PlusIcon />
              New business
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {businesses.map((b) => (
            <li key={b.id}>
              <Link
                to={`/businesses/${b.id}/overview`}
                className="group flex items-center gap-3 rounded-xl border bg-card p-4 shadow-xs outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground">
                  {initial(b.name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{b.name}</span>
                  <span className="block text-sm text-muted-foreground">Open workspace</span>
                </span>
                <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          ))}
        </ul>
      )}

      <CreateBusinessDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  )
}

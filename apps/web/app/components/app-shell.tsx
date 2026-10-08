import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { Link, Outlet, useLocation, useMatch, useNavigate } from "react-router"
import {
  BookCheckIcon,
  Building2Icon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsUpDownIcon,
  GlobeIcon,
  InboxIcon,
  KeyboardIcon,
  LayoutGridIcon,
  LogOutIcon,
  PanelLeftIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
  SettingsIcon,
  UserRoundIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { sectionTitles } from "@/lib/nav"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CreateBusinessDialog } from "@/components/create-business-dialog"
import { useSettings } from "@/components/settings-dialog"
import { rememberedEmail, usePreferences } from "@/lib/preferences"
import { Auth } from "@/lib/api"
import { initial } from "@/lib/format"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

type SidebarState = { collapsed: boolean; inSheet: boolean }
const SidebarStateContext = createContext<SidebarState>({ collapsed: false, inSheet: false })

// Lets page content (e.g. an active agent chat) ask the shell header to get
// out of the way. Reset on every navigation.
const ChromeContext = createContext<{ setMinimal: (v: boolean) => void }>({ setMinimal: () => undefined })
export const useChrome = () => useContext(ChromeContext)

const COLLAPSED_KEY = "openrecord:sidebar-collapsed"

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1"
  } catch {
    return false
  }
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [minimal, setMinimal] = useState(false)
  const location = useLocation()
  const chrome = useMemo(() => ({ setMinimal }), [])

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0")
    } catch {
      // Convenience only.
    }
  }, [collapsed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setCollapsed((c) => !c)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => setMobileOpen(false), [location.pathname])
  useEffect(() => setMinimal(false), [location.pathname])

  return (
    <ChromeContext.Provider value={chrome}>
    <div className="flex h-svh overflow-hidden bg-sidebar">
      <aside
        data-collapsed={collapsed}
        className={cn(
          "hidden h-svh shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out md:flex",
          collapsed ? "w-[3.25rem]" : "w-64",
        )}
      >
        <SidebarStateContext.Provider value={{ collapsed, inSheet: false }}>
          <SidebarBody />
        </SidebarStateContext.Provider>
      </aside>

      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent className="text-sidebar-foreground">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">Switch business and move between sections</SheetDescription>
          <SidebarStateContext.Provider value={{ collapsed: false, inSheet: true }}>
            <SidebarBody />
          </SidebarStateContext.Provider>
        </SheetContent>
      </Sheet>

      {/* Content sits on the sidebar-colored canvas as an inset, rounded panel
          that scrolls on its own, so the chrome reads as one layer below it. */}
      <div className="flex min-w-0 flex-1 flex-col p-2 md:pl-0">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-background shadow-(--panel-shadow)">
        <header className="flex h-12 shrink-0 items-center gap-2 px-3">
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <PanelLeftIcon />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="hidden md:inline-flex"
                onClick={() => setCollapsed((c) => !c)}
                aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                <PanelLeftIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle sidebar (Ctrl B)</TooltipContent>
          </Tooltip>
          {minimal ? null : (
            <>
              <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
              <Breadcrumbs />
            </>
          )}
        </header>
        <main className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-8 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
        </div>
      </div>
    </div>
    </ChromeContext.Provider>
  )
}

function SidebarBody() {
  const { collapsed } = useContext(SidebarStateContext)
  const { activeBusiness, overview } = useWorkspace()
  const base = activeBusiness ? `/businesses/${activeBusiness.id}` : null
  const { preferences } = usePreferences()
  const attention = overview && preferences.showIssueCount ? Number(overview.needs_attention) + Number(overview.unreviewed) : 0

  return (
    <>
      <div className={cn("flex h-14 shrink-0 items-center pt-2", collapsed ? "justify-center px-1.5" : "px-2")}>
        <BusinessSwitcher />
      </div>

      <nav className={cn("flex flex-1 flex-col gap-6 overflow-y-auto py-4", collapsed ? "px-1.5" : "px-2")}>
        {base ? (
          <SidebarGroup label="Workspace">
            <SidebarLink to={`${base}/overview`} icon={<LayoutGridIcon />} label="Overview" />
            <SidebarLink to={`${base}/assay`} icon={<SearchIcon />} label="Prospect assay" />
            <SidebarLink to={`${base}/search`} icon={<SearchIcon />} label="Search" />
            <SidebarLink to={`${base}/issues`} icon={<InboxIcon />} label="Issues" count={attention} />
            <SidebarLink to={`${base}/representations`} icon={<GlobeIcon />} label="Representations" />
            <SidebarLink to={`${base}/truth`} icon={<BookCheckIcon />} label="Truth" />
            <SidebarLink to={`${base}/checks`} icon={<RadarIcon />} label="Checks" />
          </SidebarGroup>
        ) : null}
        <SidebarGroup label="Account">
          <SidebarLink to="/" end icon={<Building2Icon />} label="All businesses" />
        </SidebarGroup>
      </nav>

      <div className={cn("shrink-0 py-2", collapsed ? "px-1.5" : "px-2")}>
        <AccountMenu />
      </div>
    </>
  )
}

function SidebarGroup({ label, children }: { label: string; children: ReactNode }) {
  const { collapsed } = useContext(SidebarStateContext)
  return (
    <div className="flex flex-col gap-0.5">
      {collapsed ? null : <div className="px-2 pb-1.5 text-xs font-medium text-muted-foreground">{label}</div>}
      {children}
    </div>
  )
}

function SidebarLink({ to, icon, label, count, end }: { to: string; icon: ReactNode; label: string; count?: number; end?: boolean }) {
  const { collapsed } = useContext(SidebarStateContext)
  // Resolve active state here: a function className would not survive the
  // tooltip's Slot merge in collapsed mode.
  const isActive = useMatch({ path: to, end: end ?? false }) !== null
  const link = (
    <Link
      to={to}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "group/link relative flex h-8 items-center gap-2.5 rounded-md text-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
        collapsed ? "w-9 justify-center" : "px-2",
        isActive ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground [&_svg]:text-primary" : "[&_svg]:text-muted-foreground",
      )}
    >
      {icon}
      {collapsed ? (
        count ? <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-wrong" aria-label={`${count} open`} /> : null
      ) : (
        <>
          <span className="truncate">{label}</span>
          {count ? (
            <span className="ml-auto rounded-md bg-wrong-soft px-1.5 py-px text-xs font-medium tabular-nums text-wrong">{count}</span>
          ) : null}
        </>
      )}
    </Link>
  )
  if (!collapsed) return link
  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{count ? `${label} (${count})` : label}</TooltipContent>
    </Tooltip>
  )
}

function BusinessMark({ name, className }: { name: string | null; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-sm font-semibold text-primary-foreground",
        className,
      )}
    >
      {name ? initial(name) : <Building2Icon className="size-4" />}
    </span>
  )
}

function BusinessSwitcher() {
  const { collapsed } = useContext(SidebarStateContext)
  const { businesses, activeBusiness } = useWorkspace()
  const [createOpen, setCreateOpen] = useState(false)
  const nav = useNavigate()

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-2.5 rounded-md text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-sidebar-accent",
              collapsed ? "size-9 justify-center" : "h-10 w-full px-1.5",
            )}
            aria-label="Switch business"
          >
            <BusinessMark name={activeBusiness?.name ?? null} />
            {collapsed ? null : (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">{activeBusiness?.name ?? "OpenRecord"}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {activeBusiness ? "Business" : "Choose a business"}
                  </span>
                </span>
                <ChevronsUpDownIcon className="size-4 text-muted-foreground" />
              </>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side={collapsed ? "right" : "bottom"} className="w-60">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Businesses</DropdownMenuLabel>
          {businesses.map((b) => (
            <DropdownMenuItem key={b.id} onSelect={() => nav(`/businesses/${b.id}/overview`)}>
              <BusinessMark name={b.name} className="size-6 text-xs" />
              <span className="truncate">{b.name}</span>
              {activeBusiness?.id === b.id ? <CheckIcon className="ml-auto text-foreground" /> : null}
            </DropdownMenuItem>
          ))}
          {businesses.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={() => setCreateOpen(true)}>
            <PlusIcon />
            New business
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateBusinessDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  )
}

function AccountMenu() {
  const { collapsed } = useContext(SidebarStateContext)
  const { openSettings } = useSettings()
  const nav = useNavigate()
  const email = rememberedEmail()
  const name = email ? email.split("@")[0] ?? email : "Your account"

  const avatar = (size: string) => (
    <span className={cn("flex shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary", size)}>
      {email ? email.charAt(0).toUpperCase() : <UserRoundIcon className="size-4" />}
    </span>
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-2.5 rounded-md text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-sidebar-accent",
            collapsed ? "size-9 justify-center" : "h-11 w-full px-1.5",
          )}
          aria-label="Account menu"
        >
          {avatar("size-7")}
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-foreground">{name}</span>
                {email ? <span className="block truncate text-xs text-muted-foreground">{email}</span> : null}
              </span>
              <ChevronsUpDownIcon className="size-4 text-muted-foreground" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={collapsed ? "right" : "top"}
        sideOffset={8}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-64 rounded-xl p-1.5 shadow-(--float-shadow-strong) [&_[data-slot=dropdown-menu-item]]:h-9 [&_[data-slot=dropdown-menu-item]]:rounded-md [&_[data-slot=dropdown-menu-item]]:px-2.5"
      >
        <div className="flex items-center gap-3 px-2.5 py-2.5">
          {avatar("size-9")}
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{name}</div>
            <div className="truncate text-xs text-muted-foreground">{email ?? "Signed in"}</div>
          </div>
        </div>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem onSelect={() => openSettings("general")}>
          <SettingsIcon />
          Settings
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSettings("account")}>
          <UserRoundIcon />
          Account
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openSettings("shortcuts")}>
          <KeyboardIcon />
          Keyboard shortcuts
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem onSelect={() => nav("/")}>
          <Building2Icon />
          All businesses
        </DropdownMenuItem>
        <DropdownMenuSeparator className="my-1.5" />
        <DropdownMenuItem onSelect={() => void Auth.signout().finally(() => nav("/signin"))}>
          <LogOutIcon />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Breadcrumbs() {
  const location = useLocation()
  const { activeBusiness } = useWorkspace()
  const parts = location.pathname.split("/").filter(Boolean)
  const crumbs: Array<{ label: string; to?: string }> = []

  if (parts[0] === "businesses" && activeBusiness) {
    const base = `/businesses/${activeBusiness.id}`
    crumbs.push({ label: activeBusiness.name, to: `${base}/overview` })
    const section = parts[2] ?? ""
    const detail = parts[3]
    if (section === "search" && detail === "sites" && parts[5] === "findings" && parts[6]) {
      crumbs.push({ label: "Search", to: `${base}/search` })
      crumbs.push({ label: "Finding" })
    } else if (section === "search" && detail) {
      crumbs.push({ label: "Search", to: `${base}/search` })
      crumbs.push({ label: detail === "sites" ? "Site" : (sectionTitles[detail] ?? "Search") })
    } else if ((section === "issues" || section === "representations") && detail) {
      const parent = section === "issues" ? "Issues" : "Representations"
      const child = section === "issues" ? "Issue" : detail === "discovery" ? "Discovery" : "Representation"
      crumbs.push({ label: parent, to: `${base}/${section}` })
      crumbs.push({ label: child })
    } else {
      crumbs.push({ label: sectionTitles[section] ?? "Overview" })
    }
  } else if (parts[0] === "observations") {
    if (activeBusiness) {
      crumbs.push({ label: activeBusiness.name, to: `/businesses/${activeBusiness.id}/overview` })
      crumbs.push({ label: "Checks", to: `/businesses/${activeBusiness.id}/checks` })
    }
    crumbs.push({ label: "AI answer" })
  } else {
    crumbs.push({ label: "All businesses" })
  }

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => (
          <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
            {i > 0 ? <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/70" /> : null}
            {c.to ? (
              <Link to={c.to} className="truncate text-muted-foreground transition-colors hover:text-foreground">
                {c.label}
              </Link>
            ) : (
              <span className="truncate font-medium text-foreground">{c.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

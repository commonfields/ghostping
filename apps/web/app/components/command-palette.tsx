// "Find…": one keyboard-first jump list for the workspace. F or ⌘K opens it;
// arrows move, Enter goes. Claims and facts load only while it is open.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router"
import {
  BookCheckIcon,
  Building2Icon,
  CornerDownLeftIcon,
  FileCheck2Icon,
  FlaskConicalIcon,
  GlobeIcon,
  InboxIcon,
  LayoutGridIcon,
  MessageSquareQuoteIcon,
  PlusIcon,
  RadarIcon,
  SearchIcon,
  SettingsIcon,
  TelescopeIcon,
} from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { useSettings } from "@/components/settings-dialog"
import { IssueStateBadge } from "@/components/status"
import { Facts, Issues, type IssueState } from "@/lib/api"
import { groupClaims } from "@/lib/issues"
import { initial, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"

type Item = {
  id: string
  group: string
  label: string
  hint?: string
  icon: ReactNode
  keywords?: string
  badge?: IssueState
  run: () => void
}

const PaletteContext = createContext<{ open: () => void }>({ open: () => undefined })
export const useCommandPalette = () => useContext(PaletteContext)

const isTyping = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ctx = useMemo(() => ({ open: () => setOpen(true) }), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) || (e.key.toLowerCase() === "f" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target))) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <PaletteContext.Provider value={ctx}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-[14%] max-w-2xl translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-2xl [&>button:last-child]:hidden">
          <DialogTitle className="sr-only">Find in OpenRecord</DialogTitle>
          <DialogDescription className="sr-only">Jump to a page, a business, a claim, or a fact.</DialogDescription>
          {open ? <Palette close={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </PaletteContext.Provider>
  )
}

function Palette({ close }: { close: () => void }) {
  const nav = useNavigate()
  const { businesses, activeBusiness } = useWorkspace()
  const { openSettings } = useSettings()
  const [q, setQ] = useState("")
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const bid = activeBusiness?.id ?? null
  const issues = useApi(bid ? `palette-issues:${bid}` : null, () => Issues.list(bid ?? ""))
  const facts = useApi(bid ? `palette-facts:${bid}` : null, () => Facts.list(bid ?? ""))

  const go = (to: string) => () => {
    close()
    nav(to)
  }

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    if (bid) {
      const base = `/businesses/${bid}`
      const pages: Array<[string, string, ReactNode, string]> = [
        ["Overview", "overview", <LayoutGridIcon key="i" />, "today dashboard analytics"],
        ["Issues", "issues", <InboxIcon key="i" />, "wrong claims inbox review"],
        ["Representations", "representations", <GlobeIcon key="i" />, "sources drift in sync"],
        ["Truth", "truth", <BookCheckIcon key="i" />, "facts approved"],
        ["Checks", "checks", <RadarIcon key="i" />, "questions run"],
        ["Search", "search", <SearchIcon key="i" />, "website seo findings"],
        ["Prospect assay", "assay", <FlaskConicalIcon key="i" />, "assay prospect"],
        ["Discover sources", "representations/discovery", <TelescopeIcon key="i" />, "discovery scan"],
      ]
      for (const [label, path, icon, keywords] of pages) out.push({ id: `page:${path}`, group: activeBusiness?.name ?? "Workspace", label, icon, keywords, run: go(`${base}/${path}`) })
      out.push({ id: "action:check", group: "Actions", label: "Run a check", icon: <RadarIcon />, keywords: "ask ai question", run: go(`${base}/checks`) })
      const reviewNext = (issues.data?.issues ?? []).find((i) => i.state === "NEEDS_REVIEW")
      if (reviewNext) {
        out.push({
          id: "action:review",
          group: "Actions",
          label: "Review the next claim",
          hint: "Oldest answers wait longest",
          icon: <MessageSquareQuoteIcon />,
          run: go(`/observations/${reviewNext.observation_id}?claim=${reviewNext.claim_id}`),
        })
      }
    }
    out.push({ id: "action:new-business", group: "Actions", label: "New business", icon: <PlusIcon />, run: go("/businesses?new=1") })
    out.push({
      id: "action:settings",
      group: "Actions",
      label: "Settings",
      icon: <SettingsIcon />,
      run: () => {
        close()
        openSettings("general")
      },
    })
    out.push({ id: "page:clients", group: "Agency", label: "Clients", icon: <FileCheck2Icon />, keywords: "agency record share", run: go("/clients") })
    out.push({ id: "page:businesses", group: "Agency", label: "All businesses", icon: <Building2Icon />, run: go("/businesses") })
    for (const b of businesses) {
      if (b.id === bid) continue
      out.push({
        id: `business:${b.id}`,
        group: "Switch business",
        label: b.name,
        icon: <span className="flex size-4 items-center justify-center rounded bg-primary text-[9px] font-semibold text-primary-foreground">{initial(b.name)}</span>,
        run: go(`/businesses/${b.id}/overview`),
      })
    }
    if (bid) {
      for (const g of groupClaims(issues.data?.issues ?? [], "frequent")) {
        const target = g.occurrences.find((o) => o.state !== "NEEDS_REVIEW") ?? g.latest
        out.push({
          id: `claim:${g.key}`,
          group: "Claims",
          label: g.text,
          hint: `${g.occurrences.length}×`,
          badge: g.state,
          icon: <MessageSquareQuoteIcon />,
          keywords: g.questions.join(" "),
          run: go(
            target.state === "NEEDS_REVIEW"
              ? `/observations/${target.observation_id}?claim=${target.claim_id}`
              : `/businesses/${bid}/issues/${target.claim_id}`,
          ),
        })
      }
      for (const f of (facts.data?.facts ?? []).filter((f) => f.status === "ACTIVE")) {
        out.push({
          id: `fact:${f.id}`,
          group: "Approved facts",
          label: `${sentenceCase(f.predicate)}: ${f.valueText}`,
          hint: `v${f.version}`,
          icon: <BookCheckIcon />,
          keywords: f.subject,
          run: go(`/businesses/${bid}/truth`),
        })
      }
    }
    return out
  }, [bid, activeBusiness?.name, businesses, issues.data, facts.data]) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return items.filter((i) => i.group !== "Claims" && i.group !== "Approved facts").concat(items.filter((i) => i.group === "Claims").slice(0, 5))
    const words = needle.split(/\s+/)
    return items.filter((i) => {
      const hay = `${i.label} ${i.keywords ?? ""} ${i.group}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [items, q])

  useEffect(() => setIndex(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" })
  }, [index])

  const groups: Array<[string, Array<Item & { i: number }>]> = []
  filtered.forEach((item, i) => {
    const last = groups.at(-1)
    if (last && last[0] === item.group) last[1].push({ ...item, i })
    else groups.push([item.group, [{ ...item, i }]])
  })

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setIndex((x) => Math.min(filtered.length - 1, x + 1))
        } else if (e.key === "ArrowUp") {
          e.preventDefault()
          setIndex((x) => Math.max(0, x - 1))
        } else if (e.key === "Enter") {
          e.preventDefault()
          filtered[index]?.run()
        }
      }}
    >
      <div className="flex items-center gap-2.5 border-b px-4">
        <SearchIcon className="size-4 text-muted-foreground" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder={activeBusiness ? `Find in ${activeBusiness.name}…` : "Find…"}
          className="h-11 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          aria-label="Find"
        />
        <Kbd>Esc</Kbd>
      </div>
      <div ref={listRef} className="max-h-[min(26rem,60vh)] overflow-y-auto p-1.5">
        {filtered.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">Nothing matches &ldquo;{q}&rdquo;.</p>
        ) : (
          groups.map(([group, list]) => (
            <div key={group} className="pb-1">
              <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">{group}</div>
              {list.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-index={item.i}
                  onMouseMove={() => setIndex(item.i)}
                  onClick={item.run}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-xs outline-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
                    index === item.i && "bg-accent",
                  )}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.badge ? <IssueStateBadge state={item.badge} /> : null}
                  {item.hint ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{item.hint}</span> : null}
                  {index === item.i ? <CornerDownLeftIcon className="size-3.5!" /> : null}
                </button>
              ))}
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-3 border-t bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>F</Kbd> or <Kbd>⌘K</Kbd> anywhere
        </span>
      </div>
    </div>
  )
}

import { createContext, useContext, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Link } from "react-router"
import { ChevronLeftIcon } from "lucide-react"
import { cn } from "@/lib/utils"

// The shell's top bar exposes a slot; pages render their controls into it so
// the content area starts with the work, not a toolbar.
export const HeaderSlotContext = createContext<HTMLElement | null>(null)

/** Renders children in the shell top bar (right side), or inline when there is no shell. */
export function HeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(HeaderSlotContext)
  if (!slot) return <div className="flex flex-wrap items-center gap-2">{children}</div>
  return createPortal(children, slot)
}

/** Page title: one short line of purpose; page controls go to the top bar. */
export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
  aside,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  back?: { to: string; label: string }
  meta?: ReactNode
  /** Inline content on the right of the title (kept in the page, unlike actions). */
  aside?: ReactNode
}) {
  return (
    <div className="space-y-2">
      {actions ? <HeaderActions>{actions}</HeaderActions> : null}
      {back ? (
        <Link
          to={back.to}
          className="-ml-1 inline-flex items-center gap-0.5 rounded-md px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeftIcon className="size-3.5" />
          {back.label}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0 space-y-1">
          <h1 className="text-sm leading-snug font-medium tracking-tight text-balance">{title}</h1>
          {description ? <div className="max-w-prose text-xs leading-relaxed text-muted-foreground">{description}</div> : null}
          {meta ? <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1 text-xs text-muted-foreground">{meta}</div> : null}
        </div>
        {aside ? <div className="flex shrink-0 flex-wrap items-center gap-2">{aside}</div> : null}
      </div>
    </div>
  )
}

/** A white card on the canvas: no border, a soft ring shadow. */
export function Panel({ className, children, id }: { className?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} className={cn("overflow-hidden rounded-xl bg-card text-card-foreground shadow-(--card-shadow)", className)}>
      {children}
    </section>
  )
}

/** Card heading: 14px title over a 12px muted line, controls on the right. */
export function PanelHeader({
  title,
  description,
  children,
  icon,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  icon?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-3.5 pb-1", className)}>
      <div className="flex min-w-0 items-start gap-2">
        {icon ? <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">{icon}</span> : null}
        <div className="min-w-0">
          <h2 className="text-xs leading-tight font-medium">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  )
}

export type Stat = {
  key: string
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  delta?: ReactNode
  tone?: "wrong" | "partial" | "unknown" | "review" | "supported"
  active?: boolean
  onSelect?: () => void
}

const toneDot: Record<NonNullable<Stat["tone"]>, string> = {
  wrong: "bg-wrong",
  partial: "bg-partial",
  unknown: "bg-unknown",
  review: "bg-review",
  supported: "bg-supported",
}

/**
 * Key figures without a frame: hairline dividers between cells, and the
 * selected cell lifts into a card. Cells are filters/selectors when onSelect is set.
 */
export function StatStrip({ stats, className }: { stats: Stat[]; className?: string }) {
  const cols =
    stats.length >= 6
      ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
      : stats.length === 5
        ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
        : stats.length === 4
          ? "grid-cols-2 lg:grid-cols-4"
          : "grid-cols-1 sm:grid-cols-3"
  return (
    <div
      className={cn(
        "relative grid gap-2 lg:gap-0",
        "lg:[&>*:not(:first-child)]:before:absolute lg:[&>*:not(:first-child)]:before:inset-y-2.5 lg:[&>*:not(:first-child)]:before:left-0 lg:[&>*:not(:first-child)]:before:w-px lg:[&>*:not(:first-child)]:before:bg-border/70 lg:[&>*:not(:first-child)]:before:content-['']",
        cols,
        className,
      )}
    >
      {stats.map((s) => {
        const body = (
          <>
            <span className="flex w-full items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-muted-foreground">
                {s.tone ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", toneDot[s.tone])} /> : null}
                {s.label}
              </span>
              {s.delta ? <span className="shrink-0 text-xs font-medium tabular-nums">{s.delta}</span> : null}
            </span>
            <span className="mt-1.5 text-sm leading-none font-semibold tracking-tight tabular-nums">{s.value}</span>
            {s.hint ? <span className="mt-1.5 w-full truncate text-[11px] text-muted-foreground">{s.hint}</span> : null}
          </>
        )
        const cell = cn(
          "group relative isolate flex min-w-0 flex-col items-start rounded-lg px-4 py-3 text-left",
          "after:pointer-events-none after:absolute after:inset-y-0 after:inset-x-0 after:-z-10 after:rounded-lg after:bg-card after:shadow-(--card-shadow) after:transition-opacity after:duration-200 after:content-[''] lg:after:inset-x-1.5",
          s.active ? "after:opacity-100" : "after:opacity-0",
        )
        return s.onSelect ? (
          <button
            key={s.key}
            type="button"
            aria-pressed={s.active ?? false}
            onClick={s.onSelect}
            className={cn(cell, "cursor-pointer outline-none transition-transform duration-200 active:scale-[0.99] hover:after:opacity-100", !s.active && "hover:after:opacity-60")}
          >
            {body}
          </button>
        ) : (
          <div key={s.key} className={cell}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-12 text-center", className)}>
      <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-card text-muted-foreground shadow-(--card-shadow) [&_svg]:size-5">{icon}</div>
      <h3 className="text-xs font-medium">{title}</h3>
      <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  )
}

/** Small labelled value, used in detail headers and side rails. */
export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 gap-0.5", className)}>
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-xs font-medium break-words">{children}</dd>
    </div>
  )
}

/** A ranked row with its share drawn as a sidebar-toned fill behind it. */
export function ShareRow({
  share,
  children,
  value,
  cssVar = "--sidebar-accent",
  className,
}: {
  share: number
  children: ReactNode
  value?: ReactNode
  cssVar?: string
  className?: string
}) {
  return (
    <div className={cn("relative isolate flex min-w-0 items-center justify-between gap-3 overflow-hidden rounded-md px-2 py-1.5", className)}>
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 -z-10 rounded-md"
        style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%`, background: `var(${cssVar})` }}
      />
      <span className="flex min-w-0 flex-1 items-center gap-2 text-xs">{children}</span>
      {value !== undefined ? <span className="shrink-0 text-xs font-medium tabular-nums">{value}</span> : null}
    </div>
  )
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return url
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}` || "/"
  } catch {
    return ""
  }
}

export type FlowStep = { key: string; label: ReactNode; hint?: ReactNode; icon?: ReactNode; state?: "done" | "current" | "todo"; value?: ReactNode }

/** A left-to-right process, one card per stage, joined by a thin line. */
export function StepFlow({ steps, className }: { steps: FlowStep[]; className?: string }) {
  return (
    <ol className={cn("grid gap-2", steps.length >= 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3", className)}>
      {steps.map((s, i) => (
        <li
          key={s.key}
          className={cn(
            "relative flex items-start gap-3 rounded-xl bg-card p-3.5 shadow-(--card-shadow)",
            s.state === "todo" && "bg-card/60 shadow-none ring-1 ring-border/70",
          )}
        >
          <span
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold [&_svg]:size-3.5",
              s.state === "done" ? "bg-supported-soft text-supported" : s.state === "current" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
            )}
          >
            {s.icon ?? i + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className={cn("text-xs font-medium", s.state === "todo" && "text-muted-foreground")}>{s.label}</span>
              {s.value !== undefined ? <span className="text-xs font-semibold tabular-nums">{s.value}</span> : null}
            </span>
            {s.hint ? <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{s.hint}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

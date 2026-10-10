import { useEffect, useState, type ReactNode } from "react"
import { useId } from "react"
import { Area, Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts"
import { ProviderLogo, providerBrand } from "@/components/provider-logo"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { VerdictCounts } from "@/lib/api"
import { usePreferences } from "@/lib/preferences"
import { cn } from "@/lib/utils"

// Stack order is part of the colorblind-safety check: red and green are
// never adjacent. Keep this order everywhere verdicts are drawn.
export const verdictSeries = [
  { key: "wrong", label: "Wrong", cssVar: "--chart-wrong" },
  { key: "unknown", label: "Not enough information", cssVar: "--chart-unknown" },
  { key: "partial", label: "Partially correct", cssVar: "--chart-partial" },
  { key: "unreviewed", label: "Waiting for review", cssVar: "--chart-unreviewed" },
  { key: "supported", label: "Supported", cssVar: "--chart-supported" },
] as const satisfies ReadonlyArray<{ key: keyof VerdictCounts; label: string; cssVar: string }>

export type VerdictKey = (typeof verdictSeries)[number]["key"]

export function totalClaims(c: VerdictCounts): number {
  return c.supported + c.wrong + c.partial + c.unknown + c.unreviewed
}

// SVG presentation attributes do not resolve CSS variables reliably, so read
// the tokens and re-read them whenever the theme flips.
export function useCssColors(vars: readonly string[]): Record<string, string> {
  const { resolvedTheme } = usePreferences()
  const key = vars.join(",")
  const [colors, setColors] = useState<Record<string, string>>({})
  useEffect(() => {
    const style = getComputedStyle(document.documentElement)
    setColors(Object.fromEntries(key.split(",").map((v) => [v, style.getPropertyValue(v).trim()])))
  }, [key, resolvedTheme])
  return colors
}

export function Swatch({ cssVar, className }: { cssVar: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-[3px]", className)} style={{ background: `var(${cssVar})` }} />
}

export function Legend({ items }: { items: ReadonlyArray<{ label: string; cssVar: string; value?: ReactNode }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <Swatch cssVar={i.cssVar} />
          <span>{i.label}</span>
          {i.value !== undefined ? <span className="font-medium tabular-nums text-foreground">{i.value}</span> : null}
        </li>
      ))}
    </ul>
  )
}

/** Part-to-whole bar for one row. Segments keep a 2px surface gap. */
export function VerdictBar({ counts, className }: { counts: VerdictCounts; className?: string }) {
  const total = totalClaims(counts)
  if (total === 0) return <div className={cn("h-2 rounded-full bg-muted", className)} aria-label="No claims" />
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn("flex h-2 w-full cursor-default gap-[2px] overflow-hidden rounded-full", className)} aria-label={verdictSummary(counts)}>
          {verdictSeries.map((s) =>
            counts[s.key] > 0 ? (
              <span key={s.key} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(counts[s.key] / total) * 100}%`, background: `var(${s.cssVar})` }} />
            ) : null,
          )}
        </div>
      </TooltipTrigger>
      <TooltipContent className="border bg-popover p-0 text-popover-foreground shadow-(--float-shadow-strong)">
        <VerdictTooltipBody counts={counts} />
      </TooltipContent>
    </Tooltip>
  )
}

function verdictSummary(c: VerdictCounts): string {
  return verdictSeries
    .filter((s) => c[s.key] > 0)
    .map((s) => `${c[s.key]} ${s.label.toLowerCase()}`)
    .join(", ")
}

function VerdictTooltipBody({ counts, title }: { counts: VerdictCounts; title?: string }) {
  return (
    <div className="min-w-44 space-y-1.5 px-3 py-2.5">
      {title ? <div className="pb-0.5 text-xs font-medium">{title}</div> : null}
      {verdictSeries.map((s) => (
        <div key={s.key} className="flex items-center gap-2 text-xs">
          <Swatch cssVar={s.cssVar} />
          <span className="flex-1 opacity-80">{s.label}</span>
          <span className="font-medium tabular-nums">{counts[s.key]}</span>
        </div>
      ))}
    </div>
  )
}

type Datum = Record<string, number | string>

// Rounded data-end only on the topmost non-zero segment of each stack.
function stackShape(order: readonly string[], key: string, color: string, surface: string) {
  return function StackSegment(props: unknown) {
    const { x, y, width, height, payload } = props as { x: number; y: number; width: number; height: number; payload: Datum }
    if (!height || height <= 0) return <g />
    const top = [...order].reverse().find((k) => Number(payload[k] ?? 0) > 0)
    const r = top === key ? Math.min(4, width / 2, height) : 0
    const path =
      r > 0
        ? `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`
        : `M${x},${y + height} L${x},${y} L${x + width},${y} L${x + width},${y + height} Z`
    // A surface-colored stroke on top draws the 2px gap between segments.
    return <path d={path} fill={color} stroke={surface} strokeWidth={2} strokeLinejoin="round" />
  }
}

export function StackedDailyChart({
  data,
  series,
  height = 240,
  formatDate,
}: {
  data: Datum[]
  series: ReadonlyArray<{ key: string; label: string; cssVar: string }>
  height?: number
  formatDate: (d: string) => string
}) {
  const colors = useCssColors([...series.map((s) => s.cssVar), "--card", "--chart-axis", "--chart-grid", "--accent"])
  const order = series.map((s) => s.key)
  const surface = colors["--card"] || "transparent"

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke={colors["--chart-grid"]} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            minTickGap={24}
            tickFormatter={formatDate}
            tick={{ fontSize: 10.5, fill: colors["--chart-axis"] }}
          />
          <YAxis orientation="right" allowDecimals={false} tickCount={3} tickLine={false} axisLine={false} width={32} tick={{ fontSize: 10.5, fill: colors["--chart-axis"] }} />
          <ChartTooltip
            cursor={{ fill: colors["--accent"], opacity: 0.6 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = payload[0]?.payload as Datum
              return (
                <div className="rounded-lg bg-popover text-popover-foreground shadow-(--float-shadow-strong)">
                  <div className="min-w-44 space-y-1.5 px-3 py-2.5">
                    <div className="pb-0.5 text-xs font-medium">{formatDate(String(label))}</div>
                    {[...series].reverse().map((s) => (
                      <div key={s.key} className="flex items-center gap-2 text-xs">
                        <Swatch cssVar={s.cssVar} />
                        <span className="flex-1 text-muted-foreground">{s.label}</span>
                        <span className="font-medium tabular-nums">{Number(row[s.key] ?? 0)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            }}
          />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="stack"
              maxBarSize={28}
              isAnimationActive={false}
              fill={colors[s.cssVar] ?? "currentColor"}
              shape={stackShape(order, s.key, colors[s.cssVar] ?? "currentColor", surface)}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// Categorical slots for AI models. Known models keep a fixed slot so a model
// is the same color on every page and in every period; the order is the
// validated adjacency order, so stacks and legends follow it too. Unknown
// providers take the free slots alphabetically; past eight they fold into
// "Other" instead of generating a ninth hue.
const SERIES_SLOTS = 8
const KNOWN_SLOTS = ["openai", "claude", "gemini", "perplexity", "deepseek", "qwen", "googlesearch", "bing"] as const
const ALIASES: Record<string, string> = { anthropic: "claude", chatgpt: "openai", gpt: "openai", "google-search": "googlesearch", google: "googlesearch", microsoft: "bing" }
export const OTHER_KEY = "__other"

export type ModelSeries = { key: string; label: string; cssVar: string; members: string[] }

export function modelSeries(providers: readonly string[]): ModelSeries[] {
  const canonical = (p: string) => ALIASES[p.toLowerCase()] ?? p.toLowerCase()
  const slots = new Map<number, string[]>()
  const unknown: string[] = []
  for (const p of [...new Set(providers)]) {
    const idx = (KNOWN_SLOTS as readonly string[]).indexOf(canonical(p))
    if (idx >= 0) slots.set(idx, [...(slots.get(idx) ?? []), p])
    else unknown.push(p)
  }
  const free = Array.from({ length: SERIES_SLOTS }, (_, i) => i).filter((i) => !slots.has(i))
  const other: string[] = []
  for (const p of unknown.sort()) {
    const slot = free.shift()
    if (slot === undefined) other.push(p)
    else slots.set(slot, [p])
  }
  const series: ModelSeries[] = [...slots.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([slot, members]) => ({ key: members[0]!, label: providerBrand(members[0]!).label, cssVar: `--series-${slot + 1}`, members }))
  if (other.length) series.push({ key: OTHER_KEY, label: "Other", cssVar: "--muted-foreground", members: other })
  return series
}

export type MentionDatum = { date: string; provider: string; mentions: number }

/** Pivot provider-day rows into one row per date keyed by series key. */
export function pivotMentions(data: readonly MentionDatum[], series: readonly ModelSeries[]): Array<Record<string, number | string>> {
  const owner = new Map<string, string>()
  for (const s of series) for (const m of s.members) owner.set(m, s.key)
  const byDate = new Map<string, Record<string, number | string>>()
  for (const d of data) {
    const key = owner.get(d.provider)
    if (!key) continue
    const row = byDate.get(d.date) ?? Object.fromEntries([["date", d.date], ...series.map((s) => [s.key, 0])])
    row[key] = Number(row[key] ?? 0) + d.mentions
    byDate.set(d.date, row)
  }
  return [...byDate.keys()].sort().map((date) => byDate.get(date)!)
}

export function SeriesMark({ series }: { series: Pick<ModelSeries, "cssVar"> }) {
  return <span aria-hidden className="inline-block h-0.5 w-3 shrink-0 rounded-full" style={{ background: `var(${series.cssVar})` }} />
}

export function SeriesLogo({ series, className }: { series: ModelSeries; className?: string }) {
  return series.key === OTHER_KEY ? (
    <span aria-hidden className={cn("flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-[9px] font-semibold text-muted-foreground ring-1 ring-border", className)}>
      +{series.members.length}
    </span>
  ) : (
    <ProviderLogo provider={series.key} {...(className ? { className } : {})} />
  )
}

/**
 * Mentions per model over time: raw daily counts as thin lines, with whole
 * numbers in the tooltip. A model hovered in the ranking stays full strength
 * while the rest fade, and each line ends in a dot so the latest value is
 * easy to find.
 */
export function ModelTrendChart({
  rows,
  series,
  hidden,
  focus,
  height = 220,
  formatDate,
  valueLabel = "mentions",
}: {
  rows: Array<Record<string, number | string>>
  series: readonly ModelSeries[]
  hidden: ReadonlySet<string>
  focus: string | null
  height?: number
  formatDate: (d: string) => string
  valueLabel?: string
}) {
  const colors = useCssColors([...series.map((s) => s.cssVar), "--card", "--chart-axis", "--chart-grid", "--border"])
  const visible = series.filter((s) => !hidden.has(s.key))
  const last = rows.length - 1
  const tick = { fontSize: 10.5, fill: colors["--chart-axis"] }
  const gid = useId().replace(/:/g, "")
  const focused = focus ? visible.find((s) => s.key === focus) ?? null : null

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 6, right: 0, bottom: 0, left: 0 }}>
          <defs>
            {focused ? (
              <linearGradient id={`${gid}-focus`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors[focused.cssVar]} stopOpacity={0.16} />
                <stop offset="100%" stopColor={colors[focused.cssVar]} stopOpacity={0} />
              </linearGradient>
            ) : null}
          </defs>
          <CartesianGrid vertical={false} stroke={colors["--chart-grid"]} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={36} tickFormatter={formatDate} tick={tick} />
          <YAxis orientation="right" tickLine={false} axisLine={false} width={30} tickCount={3} allowDecimals={false} tick={tick} />
          {focused ? <Area type="monotone" dataKey={focused.key} stroke="none" fill={`url(#${gid}-focus)`} isAnimationActive={false} activeDot={false} /> : null}
          <ChartTooltip
            cursor={{ stroke: colors["--border"], strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = payload[0]?.payload as Record<string, number | string>
              const raw = (k: string) => Number(row[`${k}:raw`] ?? row[k] ?? 0)
              const ranked = [...visible].sort((a, b) => raw(b.key) - raw(a.key))
              const total = visible.reduce((n, s) => n + raw(s.key), 0)
              return (
                <div className="min-w-44 rounded-lg bg-popover px-2.5 py-2 text-popover-foreground shadow-(--float-shadow-strong)">
                  <div className="pb-1 text-[11px] font-medium">
                    {formatDate(String(label))} <span className="font-normal text-muted-foreground">· {total.toLocaleString()} {valueLabel}</span>
                  </div>
                  <div className="space-y-1">
                    {ranked.map((s) => (
                      <div key={s.key} className={cn("flex items-center gap-2 text-[11px]", focus && focus !== s.key && "opacity-40")}>
                        <SeriesMark series={s} />
                        <span className="flex-1 text-muted-foreground">{s.label}</span>
                        <span className="font-medium tabular-nums">{raw(s.key).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            }}
          />
          {visible.map((s) => {
            const color = colors[s.cssVar] ?? "currentColor"
            const dim = focus !== null && focus !== s.key
            return (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={color}
                strokeWidth={focus === s.key ? 2 : 1.5}
                strokeOpacity={dim ? 0.12 : 1}
                dot={(props: { index?: number; cx?: number; cy?: number }) =>
                  props.index === last && props.cx !== undefined && props.cy !== undefined ? (
                    <circle key={`${s.key}-end`} cx={props.cx} cy={props.cy} r={3} fill={color} fillOpacity={dim ? 0.12 : 1} stroke={colors["--card"] ?? "transparent"} strokeWidth={1.5} />
                  ) : (
                    <g key={`${s.key}-${props.index}`} />
                  )
                }
                activeDot={dim ? false : { r: 3.5, strokeWidth: 1.5, stroke: colors["--card"] ?? "transparent" }}
                isAnimationActive={false}
              />
            )
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/**
 * One metric over time: a 2px smoothed line over a soft gradient, with an
 * optional dotted comparison line (a trailing average or a second metric).
 * Three faint gridlines; the value axis sits on the right.
 */
export function AreaTrendChart({
  data,
  dataKey,
  label,
  compareKey,
  compareLabel,
  cssVar = "--chart-primary",
  compareCssVar = "--chart-compare",
  height = 260,
  formatDate,
  formatValue = (v: number) => v.toLocaleString(),
  domain,
}: {
  data: Datum[]
  dataKey: string
  label: string
  compareKey?: string
  compareLabel?: string
  cssVar?: string
  compareCssVar?: string
  height?: number
  formatDate: (d: string) => string
  formatValue?: (v: number) => string
  domain?: [number | "auto", number | "auto"]
}) {
  const colors = useCssColors([cssVar, compareCssVar, "--card", "--chart-axis", "--chart-grid", "--border"])
  const gid = useId().replace(/:/g, "")
  const color = colors[cssVar] || "currentColor"
  const tick = { fontSize: 10.5, fill: colors["--chart-axis"] }

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`${gid}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.16} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={colors["--chart-grid"]} />
          <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={10} minTickGap={40} tickFormatter={formatDate} tick={tick} />
          <YAxis
            orientation="right"
            tickLine={false}
            axisLine={false}
            width={40}
            tickCount={3}
            allowDecimals={false}
            tick={tick}
            tickFormatter={(v: number) => formatValue(v)}
            {...(domain ? { domain } : {})}
          />
          <ChartTooltip
            cursor={{ stroke: colors["--border"], strokeWidth: 1 }}
            content={({ active, payload, label: l }) => {
              if (!active || !payload?.length) return null
              const row = payload[0]?.payload as Datum
              const v = row[dataKey]
              const c = compareKey ? row[compareKey] : undefined
              return (
                <div className="min-w-40 rounded-lg bg-popover px-3 py-2 text-popover-foreground shadow-(--float-shadow-strong)">
                  <div className="pb-1 text-[11px] text-muted-foreground">{formatDate(String(l))}</div>
                  <div className="flex items-center gap-2 text-xs">
                    <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: `var(${cssVar})` }} />
                    <span className="flex-1 text-muted-foreground">{label}</span>
                    <span className="font-medium tabular-nums">{v === null || v === undefined || v === "" ? "—" : formatValue(Number(v))}</span>
                  </div>
                  {compareKey ? (
                    <div className="mt-1 flex items-center gap-2 text-xs">
                      <span aria-hidden className="w-3 border-t-[1.5px] border-dotted" style={{ borderColor: `var(${compareCssVar})` }} />
                      <span className="flex-1 text-muted-foreground">{compareLabel}</span>
                      <span className="font-medium tabular-nums">{c === null || c === undefined || c === "" ? "—" : formatValue(Number(c))}</span>
                    </div>
                  ) : null}
                </div>
              )
            }}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            name={label}
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gid}-fill)`}
            connectNulls
            isAnimationActive={false}
            activeDot={{ r: 3.5, strokeWidth: 2, stroke: colors["--card"] || "transparent", fill: color }}
          />
          {compareKey ? (
            <Line
              type="monotone"
              dataKey={compareKey}
              name={compareLabel ?? compareKey}
              stroke={colors[compareCssVar] || "currentColor"}
              strokeWidth={1.5}
              strokeDasharray="1 5"
              strokeLinecap="round"
              strokeOpacity={0.8}
              dot={false}
              activeDot={false}
              connectNulls
              isAnimationActive={false}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

/** Inline trend for stat tiles: a 2px line with a faint fill, no axes. */
export function Sparkline({ values, cssVar = "--muted-foreground", className }: { values: readonly number[]; cssVar?: string; className?: string }) {
  if (values.length < 2) return <div className={cn("h-5", className)} />
  const w = 100
  const h = 32
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)] as const)
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`).join(" ")
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden className={cn("h-5 w-full overflow-visible", className)}>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={`var(${cssVar})`} opacity={0.08} />
      <path d={line} fill="none" stroke={`var(${cssVar})`} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

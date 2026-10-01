import { useEffect, useState, type ReactNode } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts"
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
      <TooltipContent className="p-0">
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
  const colors = useCssColors([...series.map((s) => s.cssVar), "--card", "--muted-foreground", "--chart-grid", "--accent"])
  const order = series.map((s) => s.key)
  const surface = colors["--card"] || "transparent"

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke={colors["--chart-grid"]} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={10}
            minTickGap={24}
            tickFormatter={formatDate}
            tick={{ fontSize: 11, fill: colors["--muted-foreground"] }}
          />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={44} tick={{ fontSize: 11, fill: colors["--muted-foreground"] }} />
          <ChartTooltip
            cursor={{ fill: colors["--accent"], opacity: 0.6 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const row = payload[0]?.payload as Datum
              return (
                <div className="rounded-lg border bg-popover text-popover-foreground shadow-(--float-shadow-strong)">
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
              fill={colors[s.cssVar]}
              shape={stackShape(order, s.key, colors[s.cssVar] ?? "currentColor", surface)}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

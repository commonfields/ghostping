import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleHelpIcon, CircleXIcon, ClockIcon, LoaderCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { IssueState } from "@/lib/api"
import { sentenceCase } from "@/lib/format"

export const issueStateMeta: Record<IssueState, { label: string; variant: "wrong" | "partial" | "unknown" | "review"; icon: typeof CircleXIcon }> = {
  WRONG: { label: "Wrong", variant: "wrong", icon: CircleXIcon },
  PARTIAL: { label: "Partially correct", variant: "partial", icon: CircleAlertIcon },
  UNKNOWN: { label: "Not enough information", variant: "unknown", icon: CircleHelpIcon },
  NEEDS_REVIEW: { label: "Needs review", variant: "review", icon: CircleDashedIcon },
}

export function IssueStateBadge({ state }: { state: IssueState }) {
  const meta = issueStateMeta[state] ?? issueStateMeta.NEEDS_REVIEW
  const Icon = meta.icon
  return (
    <Badge variant={meta.variant}>
      <Icon />
      {meta.label}
    </Badge>
  )
}

export function RunStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "SUCCEEDED":
      return (
        <Badge variant="supported">
          <CircleCheckIcon />
          Succeeded
        </Badge>
      )
    case "FAILED":
      return (
        <Badge variant="wrong">
          <CircleXIcon />
          Failed
        </Badge>
      )
    case "RUNNING":
      return (
        <Badge variant="review">
          <LoaderCircleIcon className="animate-spin" />
          Running
        </Badge>
      )
    case "QUEUED":
      return (
        <Badge variant="secondary">
          <ClockIcon />
          Queued
        </Badge>
      )
    default:
      return <Badge variant="outline">{sentenceCase(status)}</Badge>
  }
}

export function FactStatusBadge({ status }: { status: string }) {
  if (status === "ACTIVE") return <Badge variant="supported">Active</Badge>
  return <Badge variant="secondary">{sentenceCase(status)}</Badge>
}

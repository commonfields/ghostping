import * as React from "react"
import { Slot } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// Pills: fully rounded, a hairline ring in the status hue and a soft drop
// shadow so verdicts read as objects sitting on the surface, not flat text.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-1.5 py-px text-[11px] leading-4 font-medium whitespace-nowrap shadow-(--badge-shadow) [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground",
        secondary: "border-border bg-secondary text-secondary-foreground",
        outline: "border-border bg-background text-foreground",
        wrong: "border-wrong/20 bg-wrong-soft text-wrong",
        partial: "border-partial/25 bg-partial-soft text-partial",
        unknown: "border-unknown/20 bg-unknown-soft text-unknown",
        review: "border-review/20 bg-review-soft text-review",
        supported: "border-supported/20 bg-supported-soft text-supported",
      },
    },
    defaultVariants: { variant: "default" },
  },
)

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"
  return <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }

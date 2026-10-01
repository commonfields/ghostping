import type * as React from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { usePreferences } from "@/lib/preferences"

function Toaster(props: ToasterProps) {
  const { resolvedTheme } = usePreferences()
  return (
    <Sonner
      theme={resolvedTheme}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          fontFamily: "var(--font-sans)",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }

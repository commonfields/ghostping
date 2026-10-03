let displayLocale: string | undefined

// Set from preferences; undefined follows the browser.
export function setDisplayLocale(locale: string | undefined) {
  displayLocale = locale
}

// Display helpers. Server enums arrive as SCREAMING_SNAKE; the interface
// always shows sentence case.
export function sentenceCase(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "Never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "Unknown"
  return d.toLocaleDateString(displayLocale, { month: "short", day: "numeric", year: "numeric" })
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Never"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "Unknown"
  return d.toLocaleString(displayLocale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "Unknown"
  const seconds = Math.round((then - Date.now()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(displayLocale, { numeric: "auto" })
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(seconds, "second")
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute")
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour")
  if (abs < 86400 * 30) return rtf.format(Math.round(seconds / 86400), "day")
  return formatDate(iso)
}

export function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?"
}

export function errorMessage(err: unknown): string {
  const e = err as { status?: number; tag?: string }
  if (e?.tag === "FactAuthorityConflict") return "An active fact already covers this subject and predicate. Supersede it instead of adding a second one."
  if (e?.tag === "FactAuthorityManagedByRepository") return "This business's truth is managed by its repository manifest. Change it there and sync, instead of editing here."
  if (e?.status === 401) return "Your session has ended. Sign in again to continue."
  if (e?.status === 404) return "That item no longer exists or belongs to another account."
  if (e?.status === 422) return "Some fields are missing or invalid. Check them and try again."
  if (e?.status === 429) return "The provider is rate limiting requests. Try again in a minute."
  if (e?.status && e.status >= 500) return "The server could not complete the request. Try again shortly."
  return "Something went wrong. Check your connection and try again."
}

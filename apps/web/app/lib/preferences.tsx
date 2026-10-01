import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { setDisplayLocale } from "./format"

// Interface preferences. These are per-browser conveniences, so they live in
// localStorage; nothing here is account state.
export type Theme = "light" | "dark" | "system"

export type Preferences = {
  theme: Theme
  dateLocale: string
  landingView: "agent" | "today"
  defaultProvider: "mock" | "9router"
  enterToSend: boolean
  voiceInput: boolean
  showIssueCount: boolean
  reduceMotion: boolean
}

export const defaultPreferences: Preferences = {
  theme: "system",
  dateLocale: "system",
  landingView: "agent",
  defaultProvider: "mock",
  enterToSend: true,
  voiceInput: true,
  showIssueCount: true,
  reduceMotion: false,
}

const KEY = "ghostping:preferences"

function load(): Preferences {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return defaultPreferences
    return { ...defaultPreferences, ...(JSON.parse(raw) as Partial<Preferences>) }
  } catch {
    return defaultPreferences
  }
}

type Ctx = {
  preferences: Preferences
  resolvedTheme: "light" | "dark"
  setPreference: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void
  resetPreferences: () => void
}

const PreferencesContext = createContext<Ctx | null>(null)

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(load)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches)

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener("change", onChange)
    return () => mq.removeEventListener("change", onChange)
  }, [])

  const resolvedTheme: "light" | "dark" = preferences.theme === "system" ? (systemDark ? "dark" : "light") : preferences.theme

  useEffect(() => {
    // Swap without animating every color transition on the page.
    const root = document.documentElement
    root.classList.add("theme-switching")
    root.classList.toggle("dark", resolvedTheme === "dark")
    const t = window.setTimeout(() => root.classList.remove("theme-switching"), 0)
    return () => window.clearTimeout(t)
  }, [resolvedTheme])

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(preferences))
    } catch {
      // Storage unavailable; preferences still apply for this session.
    }
    setDisplayLocale(preferences.dateLocale === "system" ? undefined : preferences.dateLocale)
    document.documentElement.toggleAttribute("data-reduce-motion", preferences.reduceMotion)
  }, [preferences])

  const setPreference = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    setPreferences((p) => ({ ...p, [key]: value }))
  }, [])

  const resetPreferences = useCallback(() => setPreferences(defaultPreferences), [])

  const value = useMemo(
    () => ({ preferences, resolvedTheme, setPreference, resetPreferences }),
    [preferences, resolvedTheme, setPreference, resetPreferences],
  )
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>
}

export function usePreferences(): Ctx {
  const ctx = useContext(PreferencesContext)
  if (!ctx) throw new Error("usePreferences must be used inside PreferencesProvider")
  return ctx
}

// The email is remembered at sign in purely for display; the API's /me does not return it.
const EMAIL_KEY = "ghostping:email"

export function rememberEmail(email: string) {
  try {
    window.localStorage.setItem(EMAIL_KEY, email)
  } catch {
    // Display only.
  }
}

export function rememberedEmail(): string | null {
  try {
    return window.localStorage.getItem(EMAIL_KEY)
  } catch {
    return null
  }
}

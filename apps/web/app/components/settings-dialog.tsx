import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { Dialog as DialogPrimitive } from "radix-ui"
import { toast } from "sonner"
import {
  CheckIcon,
  CopyIcon,
  InfoIcon,
  KeyboardIcon,
  MonitorIcon,
  MoonIcon,
  RadarIcon,
  ShieldIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  SunIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Auth } from "@/lib/api"
import { formatDate, formatDateTime } from "@/lib/format"
import { rememberedEmail, usePreferences, type Preferences } from "@/lib/preferences"
import { cn } from "@/lib/utils"

export type SettingsSection = "general" | "agent" | "checks" | "shortcuts" | "account" | "privacy" | "about"

type SettingsCtx = { openSettings: (section?: SettingsSection) => void }
const SettingsContext = createContext<SettingsCtx | null>(null)

export function useSettings(): SettingsCtx {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error("useSettings must be used inside SettingsProvider")
  return ctx
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
export const modKey = isMac ? "⌘" : "Ctrl"

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<SettingsSection>("general")

  const openSettings = useCallback((next?: SettingsSection) => {
    setSection(next ?? "general")
    setOpen(true)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "," && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const value = useMemo(() => ({ openSettings }), [openSettings])

  return (
    <SettingsContext.Provider value={value}>
      {children}
      <SettingsDialog open={open} onOpenChange={setOpen} section={section} onSectionChange={setSection} />
    </SettingsContext.Provider>
  )
}

const nav: Array<{ group: string; items: Array<{ id: SettingsSection; label: string; icon: ReactNode }> }> = [
  {
    group: "Preferences",
    items: [
      { id: "general", label: "General", icon: <SlidersHorizontalIcon /> },
      { id: "agent", label: "Agent", icon: <SparklesIcon /> },
      { id: "checks", label: "Checks", icon: <RadarIcon /> },
      { id: "shortcuts", label: "Keyboard shortcuts", icon: <KeyboardIcon /> },
    ],
  },
  {
    group: "Account",
    items: [
      { id: "account", label: "Account", icon: <UserRoundIcon /> },
      { id: "privacy", label: "Privacy and data", icon: <ShieldIcon /> },
      { id: "about", label: "About", icon: <InfoIcon /> },
    ],
  },
]

const sectionMeta: Record<SettingsSection, { title: string; description: string }> = {
  general: { title: "General", description: "Appearance, language and how the app opens." },
  agent: { title: "Agent", description: "How the chat box behaves when you talk to the agent." },
  checks: { title: "Checks", description: "Defaults for running buyer questions against AI providers." },
  shortcuts: { title: "Keyboard shortcuts", description: "Move around Ghostping without the mouse." },
  account: { title: "Account", description: "Your sign-in details and current session." },
  privacy: { title: "Privacy and data", description: "What leaves your browser, and what is kept." },
  about: { title: "About", description: "Version and build information." },
}

function SettingsDialog({
  open,
  onOpenChange,
  section,
  onSectionChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  section: SettingsSection
  onSectionChange: (s: SettingsSection) => void
}) {
  const meta = sectionMeta[section]
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          onOpenAutoFocus={(e) => {
            // Focus the panel itself rather than ringing the first nav item.
            e.preventDefault()
            ;(e.currentTarget as HTMLElement | null)?.focus()
          }}
          tabIndex={-1}
          className="fixed top-1/2 left-1/2 z-50 flex h-[min(680px,calc(100svh-2rem))] w-[min(960px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl bg-sidebar p-2 shadow-[0_0_0_1px_var(--border),0_24px_64px_rgb(0_0_0/0.22)] outline-none duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:zoom-in-[0.98] md:flex-row"
        >
          <DialogPrimitive.Description className="sr-only">Change preferences and review your account</DialogPrimitive.Description>

          <nav className="flex shrink-0 flex-col gap-4 px-1 pt-2 pb-2 md:w-56 md:px-2 md:pt-3">
            <div className="px-2 text-sm font-semibold text-foreground">Settings</div>
            <div className="flex gap-1 overflow-x-auto md:flex-col md:gap-5 md:overflow-visible">
              {nav.map((g) => (
                <div key={g.group} className="flex gap-1 md:flex-col md:gap-0.5">
                  <div className="hidden px-2 pb-1.5 text-xs font-medium text-muted-foreground md:block">{g.group}</div>
                  {g.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSectionChange(item.id)}
                      aria-current={section === item.id ? "page" : undefined}
                      className={cn(
                        "flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-left text-sm whitespace-nowrap outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
                        section === item.id
                          ? "bg-sidebar-accent font-medium text-foreground [&_svg]:text-primary"
                          : "text-sidebar-foreground [&_svg]:text-muted-foreground",
                      )}
                    >
                      {item.icon}
                      {item.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </nav>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-background shadow-(--panel-shadow)">
            <header className="flex shrink-0 items-start justify-between gap-4 px-6 py-4">
              <div className="space-y-0.5">
                <DialogPrimitive.Title className="text-base font-semibold">{meta.title}</DialogPrimitive.Title>
                <p className="text-sm text-muted-foreground">{meta.description}</p>
              </div>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon-sm" className="-mr-2 text-muted-foreground" aria-label="Close settings">
                  <XIcon />
                </Button>
              </DialogPrimitive.Close>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
              <div className="mx-auto max-w-2xl space-y-8">
                {section === "general" ? <GeneralSection /> : null}
                {section === "agent" ? <AgentSection /> : null}
                {section === "checks" ? <ChecksSection /> : null}
                {section === "shortcuts" ? <ShortcutsSection /> : null}
                {section === "account" ? <AccountSection onDone={() => onOpenChange(false)} /> : null}
                {section === "privacy" ? <PrivacySection /> : null}
                {section === "about" ? <AboutSection /> : null}
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function Group({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      <div className="divide-y rounded-xl border">{children}</div>
    </section>
  )
}

function Row({ label, description, children, htmlFor }: { label: string; description?: ReactNode; children?: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-0.5">
        <label htmlFor={htmlFor} className="block text-sm font-medium">
          {label}
        </label>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}

function PrefSwitch({ id, k }: { id: string; k: "enterToSend" | "voiceInput" | "showIssueCount" | "reduceMotion" }) {
  const { preferences, setPreference } = usePreferences()
  return <Switch id={id} checked={preferences[k]} onCheckedChange={(v) => setPreference(k, v)} />
}

const themes = [
  { id: "light", label: "Light", icon: SunIcon },
  { id: "dark", label: "Dark", icon: MoonIcon },
  { id: "system", label: "System", icon: MonitorIcon },
] as const

const locales: Array<{ value: string; label: string }> = [
  { value: "system", label: "Follow browser" },
  { value: "en-US", label: "English (United States)" },
  { value: "en-GB", label: "English (United Kingdom)" },
  { value: "id-ID", label: "Indonesian (Indonesia)" },
  { value: "de-DE", label: "German (Germany)" },
  { value: "ja-JP", label: "Japanese (Japan)" },
]

function ThemePreview({ dark }: { dark: boolean }) {
  return (
    <div className={cn("flex h-16 gap-1 rounded-md p-1", dark ? "bg-zinc-800" : "bg-zinc-100")}>
      <div className="flex w-1/4 flex-col gap-1 p-0.5">
        <div className={cn("h-1.5 rounded-full", dark ? "bg-zinc-600" : "bg-zinc-300")} />
        <div className={cn("h-1.5 w-2/3 rounded-full", dark ? "bg-zinc-700" : "bg-zinc-200")} />
      </div>
      <div className={cn("flex flex-1 flex-col gap-1 rounded p-1.5 shadow-sm", dark ? "bg-zinc-900" : "bg-white")}>
        <div className={cn("h-1.5 w-1/2 rounded-full", dark ? "bg-zinc-600" : "bg-zinc-300")} />
        <div className={cn("h-1.5 w-3/4 rounded-full", dark ? "bg-zinc-700" : "bg-zinc-200")} />
      </div>
    </div>
  )
}

function GeneralSection() {
  const { preferences, setPreference } = usePreferences()
  const now = new Date().toISOString()
  return (
    <>
      <section className="space-y-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">Appearance</h3>
          <p className="text-sm text-muted-foreground">System follows your device and switches automatically.</p>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {themes.map((t) => {
            const selected = preferences.theme === t.id
            const Icon = t.icon
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={selected}
                onClick={() => setPreference("theme", t.id)}
                className={cn(
                  "group rounded-xl border p-2 text-left outline-none transition-[box-shadow,background-color] focus-visible:ring-[3px] focus-visible:ring-ring",
                  selected ? "border-primary/50 shadow-[0_0_0_1px_var(--primary)]" : "hover:bg-muted/50",
                )}
              >
                {t.id === "system" ? (
                  <div className="grid grid-cols-2 overflow-hidden rounded-md">
                    <ThemePreview dark={false} />
                    <ThemePreview dark />
                  </div>
                ) : (
                  <ThemePreview dark={t.id === "dark"} />
                )}
                <div className="mt-2 flex items-center gap-1.5 px-0.5 text-sm">
                  <Icon className="size-3.5 text-muted-foreground" />
                  <span className="font-medium">{t.label}</span>
                  {selected ? <CheckIcon className="ml-auto size-4 text-primary" /> : null}
                </div>
              </button>
            )
          })}
        </div>
        <div className="divide-y rounded-xl border">
          <Row label="Reduce motion" description="Turn off animations and transitions in this app." htmlFor="pref-motion">
            <PrefSwitch id="pref-motion" k="reduceMotion" />
          </Row>
        </div>
      </section>

      <Group title="Language and region">
        <Row label="Interface language" description="More languages will follow.">
          <Select value="en" disabled>
            <SelectTrigger className="w-52" aria-label="Interface language">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="en">English</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row
          label="Date and time format"
          description={
            <span>
              Example: <span className="text-foreground">{formatDateTime(now)}</span>
            </span>
          }
        >
          <Select value={preferences.dateLocale} onValueChange={(v) => setPreference("dateLocale", v)}>
            <SelectTrigger className="w-52" aria-label="Date and time format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {locales.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Group>

      <Group title="Navigation">
        <Row label="Overview opens on" description="The view you land on when opening a business.">
          <Select value={preferences.landingView} onValueChange={(v) => setPreference("landingView", v as Preferences["landingView"])}>
            <SelectTrigger className="w-36" aria-label="Overview opens on">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="agent">Agent</SelectItem>
              <SelectItem value="today">Today</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="Show issue count in sidebar" description="The number next to Issues counts wrong, unclear and unreviewed claims." htmlFor="pref-count">
          <PrefSwitch id="pref-count" k="showIssueCount" />
        </Row>
      </Group>
    </>
  )
}

function AgentSection() {
  return (
    <>
      <Group title="Composer">
        <Row
          label="Send with Enter"
          description={
            <span>
              When off, use <Kbd>{modKey}</Kbd> <Kbd>Enter</Kbd> to send and Enter adds a new line.
            </span>
          }
          htmlFor="pref-enter"
        >
          <PrefSwitch id="pref-enter" k="enterToSend" />
        </Row>
        <Row label="Voice input" description="Show the microphone button. Speech is turned into text by your browser." htmlFor="pref-voice">
          <PrefSwitch id="pref-voice" k="voiceInput" />
        </Row>
      </Group>
      <Group title="Connection">
        <Row label="Agent backend" description="The agent is not connected yet, so messages stay in this page and are not sent anywhere.">
          <Badge variant="secondary">Not connected</Badge>
        </Row>
      </Group>
    </>
  )
}

function ChecksSection() {
  const { preferences, setPreference } = usePreferences()
  return (
    <Group title="Running checks">
      <Row label="Default provider" description="Preselected on the Checks page. You can still switch before each run.">
        <Select value={preferences.defaultProvider} onValueChange={(v) => setPreference("defaultProvider", v as Preferences["defaultProvider"])}>
          <SelectTrigger className="w-52" aria-label="Default provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem value="mock">Mock (test answers)</SelectItem>
            <SelectItem value="9router">9Router (live model)</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Retries" description="Rate limits, timeouts and unavailable providers are retried up to 3 times. Other failures stop right away.">
        <span className="text-sm text-muted-foreground">Managed by the server</span>
      </Row>
    </Group>
  )
}

function ShortcutsSection() {
  const groups: Array<{ title: string; items: Array<{ label: string; keys: string[] }> }> = [
    {
      title: "General",
      items: [
        { label: "Open settings", keys: [modKey, ","] },
        { label: "Toggle sidebar", keys: [modKey, "B"] },
        { label: "Close a dialog or menu", keys: ["Esc"] },
      ],
    },
    {
      title: "Agent",
      items: [
        { label: "Send message", keys: ["Enter"] },
        { label: "New line", keys: ["Shift", "Enter"] },
        { label: "Stop voice input", keys: ["Esc"] },
      ],
    },
  ]
  return (
    <>
      {groups.map((g) => (
        <Group key={g.title} title={g.title}>
          {g.items.map((i) => (
            <div key={i.label} className="flex items-center justify-between px-4 py-3 text-sm">
              <span>{i.label}</span>
              <span className="flex items-center gap-1">
                {i.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </div>
          ))}
        </Group>
      ))}
    </>
  )
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="truncate rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{value}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground"
        aria-label="Copy"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </span>
  )
}

function AccountSection({ onDone }: { onDone: () => void }) {
  const [me, setMe] = useState<{ userId: string; accountId: string } | null>(null)
  const email = rememberedEmail()
  const nav = useNavigate()

  useEffect(() => {
    Auth.me()
      .then(setMe)
      .catch(() => setMe(null))
  }, [])

  return (
    <>
      <div className="flex items-center gap-4 rounded-xl border p-4">
        <span className="flex size-12 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground">
          {email ? email.charAt(0).toUpperCase() : <UserRoundIcon className="size-5" />}
        </span>
        <div className="min-w-0">
          <div className="truncate font-medium">{email ?? "Your account"}</div>
          <div className="text-sm text-muted-foreground">Signed in with email and password</div>
        </div>
      </div>

      <Group title="Sign-in details" description="Changing your email or password is not available in the app yet.">
        <Row label="Email" description={email ?? "Sign in again on this device to show it here."} />
        <Row label="Password" description="Set when the account was created." />
      </Group>

      <Group title="Session">
        <Row label="This device" description={`Signed in. Checked ${formatDate(new Date().toISOString())}.`}>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void Auth.signout()
                .then(() => toast.success("Signed out"))
                .finally(() => {
                  onDone()
                  nav("/signin")
                })
            }
          >
            Sign out
          </Button>
        </Row>
      </Group>

      <Group title="Identifiers" description="Useful when reporting a problem.">
        <Row label="Account ID">{me ? <CopyValue value={me.accountId} /> : <span className="text-sm text-muted-foreground">Loading</span>}</Row>
        <Row label="User ID">{me ? <CopyValue value={me.userId} /> : <span className="text-sm text-muted-foreground">Loading</span>}</Row>
      </Group>
    </>
  )
}

function PrivacySection() {
  const { resetPreferences } = usePreferences()
  return (
    <>
      <Group title="What leaves your browser">
        <Row
          label="Buyer questions"
          description="Running a check sends the question text to the provider you pick. Mock checks stay on the server and cost nothing."
        />
        <Row label="Provider keys" description="Keys live only on the server. They are never sent to this page or stored with your data." />
        <Row label="Voice input" description="Your browser turns speech into text. Some browsers send audio to their own speech service to do this." />
      </Group>
      <Group title="What is kept">
        <Row
          label="Evidence"
          description="Every AI answer is stored exactly as received and cannot be edited. New verdicts are added on top, so history is never rewritten."
        />
        <Row label="Preferences" description="Settings on this screen are saved in this browser only.">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetPreferences()
              toast.success("Preferences reset")
            }}
          >
            Reset preferences
          </Button>
        </Row>
      </Group>
    </>
  )
}

function AboutSection() {
  return (
    <Group title="Ghostping">
      <Row label="Version" description="Hosted web app">
        <span className="text-sm text-muted-foreground tabular-nums">0.1.0</span>
      </Row>
      <Row label="What it does" description="Checks what AI assistants say about your business and compares it with the facts you approve." />
    </Group>
  )
}

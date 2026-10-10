import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowUpIcon, CheckIcon, CopyIcon, FileTextIcon, MicIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useChrome } from "@/components/app-shell"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { modKey } from "@/components/settings-dialog"
import { usePreferences } from "@/lib/preferences"
import { Agent } from "@/lib/api"
import { cn } from "@/lib/utils"

type Attachment = { id: string; file: File; previewUrl: string | null }
type Message = {
  id: string
  role: "user" | "agent"
  text: string
  attachments: Array<{ name: string; size: number }>
  tools?: Array<{ tool: string; summary: string }>
  pending?: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

let nextId = 0
const uid = () => `m${Date.now()}-${nextId++}`

// Minimal shape of the Web Speech API; not in the TS DOM lib.
type Recognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start: () => void
  stop: () => void
}

function createRecognition(): Recognition | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return Ctor ? new Ctor() : null
}

export function AgentChat({
  businessId,
  businessName,
  onConversationChange,
}: {
  businessId: string
  businessName: string
  onConversationChange: (active: boolean) => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const active = messages.length > 0
  const { setMinimal } = useChrome()

  useEffect(() => onConversationChange(active), [active, onConversationChange])

  useEffect(() => {
    setMinimal(active)
    return () => setMinimal(false)
  }, [active, setMinimal])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages])

  const send = (text: string, attachments: Attachment[]) => {
    const user: Message = {
      id: uid(),
      role: "user",
      text,
      attachments: attachments.map((a) => ({ name: a.file.name, size: a.file.size })),
    }
    const thinking: Message = { id: uid(), role: "agent", text: "Reading your workspace evidence…", attachments: [], pending: true }
    setMessages((m) => [...m, user, thinking])
    setFailed(null)
    // Read-only V1: the server answers from account-scoped evidence and
    // cites it. Writes are never performed; the reply plans them with UI links.
    void Agent.send(businessId, text)
      .then((r) => {
        const answer: Message = {
          id: uid(),
          role: "agent",
          text: r.reply,
          attachments: [],
          tools: r.toolCalls.map((t) => ({ tool: t.tool, summary: t.summary })),
        }
        setMessages((m) => [...m.slice(0, -1), answer])
      })
      .catch((err: unknown) => {
        setMessages((m) => m.slice(0, -1))
        setFailed(err instanceof Error ? err.message : "The agent could not answer right now.")
      })
  }

  if (!active) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center pb-[12vh]">
        <div className="w-full max-w-3xl space-y-7">
          <h1 className="text-center text-2xl font-medium tracking-tight text-balance text-foreground">
            What should we look into for {businessName}?
          </h1>
          <Composer onSend={send} placeholder={`Ask anything about ${businessName}`} />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
      <ol className="flex-1 space-y-3 pb-8">
        {messages.map((m) => (
          <li key={m.id} className={cn("group/msg flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}>
            {m.role === "user" ? (
              <>
                {m.attachments.length > 0 ? (
                  <div className="flex max-w-[80%] flex-wrap justify-end gap-2">
                    {m.attachments.map((a, i) => (
                      <span key={i} className="flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs">
                        <FileTextIcon className="size-3.5 text-muted-foreground" />
                        <span className="max-w-40 truncate">{a.name}</span>
                        <span className="text-muted-foreground">{formatSize(a.size)}</span>
                      </span>
                    ))}
                  </div>
                ) : null}
                {m.text ? (
                  <p className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-xs leading-relaxed whitespace-pre-wrap">{m.text}</p>
                ) : null}
              </>
            ) : (
              <div className="max-w-[90%] space-y-1.5">
                <p className={cn("text-xs leading-relaxed whitespace-pre-wrap text-foreground/80", m.pending && "animate-pulse")}>{m.text}</p>
                {m.tools && m.tools.length > 0 ? (
                  <p className="text-xs text-muted-foreground">Tools: {m.tools.map((t) => t.tool).join(" · ")}</p>
                ) : null}
              </div>
            )}
            <CopyButton text={m.text} className={m.role === "user" ? "-mr-1.5" : "-ml-1.5"} />
          </li>
        ))}
      </ol>
      {failed ? <p className="pb-2 text-xs text-wrong">{failed}</p> : null}
      <div ref={endRef} />

      <div className="sticky bottom-0 z-10 -mx-2 bg-gradient-to-t from-background from-70% to-transparent px-2 pt-6 pb-1">
        <Composer onSend={send} placeholder="Reply to the agent" autoFocus />
      </div>
    </div>
  )
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn("size-7 text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100", className)}
          aria-label="Copy message"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  )
}

function Composer({
  onSend,
  placeholder,
  autoFocus,
}: {
  onSend: (text: string, attachments: Attachment[]) => void
  placeholder: string
  autoFocus?: boolean
}) {
  const { preferences } = usePreferences()
  const [text, setText] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [listening, setListening] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<Recognition | null>(null)
  const baseTextRef = useRef("")

  useEffect(() => () => recognitionRef.current?.stop(), [])

  const canSend = text.trim().length > 0 || attachments.length > 0

  const submit = () => {
    if (!canSend) return
    recognitionRef.current?.stop()
    onSend(text.trim(), attachments)
    for (const a of attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
    setText("")
    setAttachments([])
    textRef.current?.focus()
  }

  const addFiles = (files: FileList | File[] | null) => {
    if (!files) return
    const next = Array.from(files).map((file) => ({
      id: uid(),
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    }))
    if (next.length) setAttachments((a) => [...a, ...next])
    textRef.current?.focus()
  }

  const removeAttachment = (id: string) =>
    setAttachments((list) => {
      const gone = list.find((a) => a.id === id)
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
      return list.filter((a) => a.id !== id)
    })

  const toggleMic = () => {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const rec = createRecognition()
    if (!rec) {
      toast.error("Voice input is not available", { description: "This browser does not support speech recognition. Try Chrome or Safari." })
      return
    }
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || "en-US"
    baseTextRef.current = text ? `${text.trimEnd()} ` : ""
    rec.onresult = (e) => {
      let transcript = ""
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i]?.[0]?.transcript ?? ""
      setText(baseTextRef.current + transcript)
    }
    rec.onerror = (e) => {
      if (e.error === "not-allowed") toast.error("Microphone access is blocked", { description: "Allow microphone access for this site, then try again." })
    }
    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
      textRef.current?.focus()
    }
    recognitionRef.current = rec
    rec.start()
    setListening(true)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onClick={(e) => {
        // The whole box behaves like the input: clicking padding focuses it.
        if (e.target === e.currentTarget) textRef.current?.focus()
      }}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) setDragging(true)
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        addFiles(e.dataTransfer.files)
      }}
      className={cn(
        "relative cursor-text rounded-3xl border border-border bg-background shadow-(--float-shadow) transition-shadow duration-200",
        "focus-within:shadow-(--float-shadow-strong)",
        dragging && "shadow-(--float-shadow-strong)",
      )}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-1.5 z-10 flex items-center justify-center rounded-[1.25rem] border border-dashed border-foreground/20 bg-background/90 text-xs text-muted-foreground">
          Drop files to attach
        </div>
      ) : null}

      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-4 pt-4">
          {attachments.map((a) => (
            <div key={a.id} className="relative flex items-center gap-2 rounded-xl border bg-muted/40 py-1.5 pr-8 pl-1.5">
              {a.previewUrl ? (
                <img src={a.previewUrl} alt="" className="size-8 rounded-lg object-cover" />
              ) : (
                <span className="flex size-8 items-center justify-center rounded-lg bg-background text-muted-foreground">
                  <FileTextIcon className="size-4" />
                </span>
              )}
              <span className="grid">
                <span className="max-w-40 truncate text-xs font-medium">{a.file.name}</span>
                <span className="text-xs text-muted-foreground">{formatSize(a.file.size)}</span>
              </span>
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                aria-label={`Remove ${a.file.name}`}
                className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <label htmlFor="agent-input" className="sr-only">
        Message the agent
      </label>
      <textarea
        id="agent-input"
        ref={textRef}
        autoFocus={autoFocus}
        rows={1}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files)
          if (files.length) {
            e.preventDefault()
            addFiles(files)
          }
        }}
        onKeyDown={(e) => {
          const sendCombo = preferences.enterToSend ? !e.shiftKey && !e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey
          if (e.key === "Enter" && sendCombo && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          } else if (e.key === "Escape" && listening) {
            recognitionRef.current?.stop()
          }
        }}
        placeholder={listening ? "Listening" : placeholder}
        className="field-sizing-content block max-h-72 min-h-28 w-full resize-none bg-transparent px-5 pt-4 pb-1 text-xs leading-relaxed outline-none placeholder:text-muted-foreground/80"
      />

      <div className="flex items-center gap-1 px-3 pb-3">
        <input
          ref={fileRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            addFiles(e.currentTarget.files)
            e.currentTarget.value = ""
          }}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="rounded-full text-muted-foreground"
              onClick={() => fileRef.current?.click()}
              aria-label="Attach files"
            >
              <PaperclipIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Attach files, or drop or paste them here</TooltipContent>
        </Tooltip>
        {preferences.voiceInput ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("rounded-full text-muted-foreground", listening && "bg-wrong-soft text-wrong hover:bg-wrong-soft hover:text-wrong")}
                onClick={toggleMic}
                aria-label={listening ? "Stop voice input" : "Start voice input"}
                aria-pressed={listening}
              >
                {listening ? <SquareIcon className="size-3 fill-current" /> : <MicIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{listening ? "Stop voice input" : "Voice input"}</TooltipContent>
          </Tooltip>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          {listening ? (
            <span className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-wrong opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-wrong" />
              </span>
              Listening
            </span>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="submit"
                  size="icon-sm"
                  className="rounded-full disabled:bg-muted-foreground/25 disabled:text-background disabled:opacity-100"
                  disabled={!canSend}
                  aria-label="Send message"
                >
                  <ArrowUpIcon />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{preferences.enterToSend ? "Send (Enter). Shift Enter adds a new line." : `Send (${modKey} Enter). Enter adds a new line.`}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </form>
  )
}

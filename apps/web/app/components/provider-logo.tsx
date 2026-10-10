import { siAnthropic, siDeepseek, siGoogle, siGooglegemini, siKimi, siMetaai, siMistralai, siOllama, siOpenrouter, siPerplexity, siQwen, siX, type SimpleIcon } from "simple-icons"
import { cn } from "@/lib/utils"

// Brand marks come from the simple-icons package. Providers with no icon
// there (OpenAI and Bing were removed at brand request) get a proper brand
// tile instead: official color, scalable letter glyph, legible both themes.
type Brand = { icon: SimpleIcon | null; label: string; tile?: string; glyph?: string; svgPath?: string }

// The OpenAI blossom: simple-icons dropped it at brand request, so the path
// below is pinned from v11 (last version shipping it), drawn in currentColor
// so the black/white tile automatically inverts with the theme.
const OPENAI_PATH =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"

const BRANDS: Record<string, Brand> = {
  anthropic: { icon: siAnthropic, label: "Claude" },
  claude: { icon: siAnthropic, label: "Claude" },
  perplexity: { icon: siPerplexity, label: "Perplexity" },
  deepseek: { icon: siDeepseek, label: "DeepSeek" },
  qwen: { icon: siQwen, label: "Qwen" },
  gemini: { icon: siGooglegemini, label: "Gemini" },
  google: { icon: siGoogle, label: "Google" },
  googlesearch: { icon: siGoogle, label: "Google Search" },
  "google-search": { icon: siGoogle, label: "Google Search" },
  openai: { icon: null, label: "OpenAI", tile: "bg-neutral-900 text-white ring-neutral-900 dark:bg-white dark:text-neutral-900 dark:ring-white", svgPath: OPENAI_PATH },
  gpt: { icon: null, label: "OpenAI", tile: "bg-neutral-900 text-white ring-neutral-900 dark:bg-white dark:text-neutral-900 dark:ring-white", svgPath: OPENAI_PATH },
  chatgpt: { icon: null, label: "ChatGPT", tile: "bg-neutral-900 text-white ring-neutral-900 dark:bg-white dark:text-neutral-900 dark:ring-white", svgPath: OPENAI_PATH },
  bing: { icon: null, label: "Bing", tile: "bg-[#0e7c86] text-white ring-[#0e7c86]", glyph: "B" },
  microsoft: { icon: null, label: "Bing", tile: "bg-[#0e7c86] text-white ring-[#0e7c86]", glyph: "B" },
  grok: { icon: siX, label: "Grok" },
  xai: { icon: siX, label: "xAI" },
  mistral: { icon: siMistralai, label: "Mistral" },
  meta: { icon: siMetaai, label: "Meta" },
  metaai: { icon: siMetaai, label: "Meta AI" },
  llama: { icon: siMetaai, label: "Llama" },
  kimi: { icon: siKimi, label: "Kimi" },
  moonshot: { icon: siKimi, label: "Moonshot" },
  ollama: { icon: siOllama, label: "Ollama" },
  openrouter: { icon: siOpenrouter, label: "OpenRouter" },
  mock: { icon: null, label: "Mock", tile: "border border-dashed border-border bg-transparent text-muted-foreground ring-0", glyph: "M" },
  "9router": { icon: null, label: "9Router", tile: "bg-primary/15 text-primary ring-primary/30", glyph: "9" },
}

export function providerBrand(provider: string): Brand {
  const hit = BRANDS[provider.toLowerCase()]
  if (hit) return hit
  return { icon: null, label: provider }
}

// Small tile so brand marks stay legible in both themes. Letter glyphs are
// SVG text so they scale with the tile instead of overflowing small sizes.
export function ProviderLogo({ provider, className }: { provider: string; className?: string }) {
  const brand = providerBrand(provider)
  return (
    <span
      aria-hidden
      title={brand.label}
      className={cn("flex size-5 shrink-0 items-center justify-center rounded-[5px] ring-1", brand.tile ?? "bg-white ring-border", className)}
    >
      {brand.icon ? (
        <svg viewBox="0 0 24 24" className="size-[70%]" fill={`#${brand.icon.hex}`} role="img">
          <path d={brand.icon.path} />
        </svg>
      ) : brand.svgPath ? (
        <svg viewBox="0 0 24 24" className="size-[75%]" fill="currentColor" role="img">
          <path d={brand.svgPath} />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="size-[70%]" role="img">
          <text x="12" y="17" textAnchor="middle" fontSize="14" fontWeight="700" fill="currentColor" fontFamily="Inter Variable, ui-sans-serif, system-ui, sans-serif">
            {brand.glyph ?? brand.label.charAt(0).toUpperCase()}
          </text>
        </svg>
      )}
    </span>
  )
}

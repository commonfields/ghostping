import { siAnthropic, siDeepseek, siGoogle, siGooglegemini, siPerplexity, siQwen, type SimpleIcon } from "simple-icons"
import { cn } from "@/lib/utils"

// Brand marks come from the simple-icons package. Two requested providers
// ship no icon there (OpenAI and Bing were removed at brand request), so
// they fall back to a letter tile like unknown providers do.
type Brand = { icon: SimpleIcon | null; label: string }

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
  openai: { icon: null, label: "OpenAI" },
  gpt: { icon: null, label: "OpenAI" },
  chatgpt: { icon: null, label: "ChatGPT" },
  bing: { icon: null, label: "Bing" },
  microsoft: { icon: null, label: "Bing" },
  mock: { icon: null, label: "Mock" },
  "9router": { icon: null, label: "9Router" },
}

export function providerBrand(provider: string): Brand {
  const hit = BRANDS[provider.toLowerCase()]
  if (hit) return hit
  return { icon: null, label: provider }
}

// Small white tile so colored brand marks stay legible in both themes.
export function ProviderLogo({ provider, className }: { provider: string; className?: string }) {
  const brand = providerBrand(provider)
  return (
    <span
      aria-hidden
      title={brand.label}
      className={cn("flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-white ring-1 ring-border", className)}
    >
      {brand.icon ? (
        <svg viewBox="0 0 24 24" className="size-[70%]" fill={`#${brand.icon.hex}`} role="img">
          <path d={brand.icon.path} />
        </svg>
      ) : (
        <span className="text-[0.6rem] leading-none font-bold text-neutral-600">{brand.label.charAt(0).toUpperCase()}</span>
      )}
    </span>
  )
}

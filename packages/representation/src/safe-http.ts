// Shared safe HTTP primitive: mandatory SSRF protection + bounded fetch.
// Both NativeHttpCollector (explicit targets) and Discovery (scoped crawl)
// must use this path. No fetch path may bypass it.
//
// Security model (defense in depth):
// 1. DNS preflight: reject empty or forbidden answer sets.
// 2. IP pinning: dial the validated IP literally, never re-resolve.
// 3. Connect-time peer check: peer must be in validated set and not forbidden.
// 4. Redirect re-validation per hop + scope-aware cross-origin policy.
// 5. Hard byte ceilings on every body (success/error/unsupported alike).
// 6. Timeouts covering connect + headers + streamed body.

import { createHash } from "node:crypto"
import { lookup as dnsLookupDefault } from "node:dns/promises"
import { isIP } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

export interface SafeFetchLimits {
  readonly timeoutMs: number
  readonly maxRedirects: number
  readonly maxBytes: number
  readonly acceptedContentTypes: ReadonlyArray<string> | null
}

export const DEFAULT_SAFE_LIMITS: SafeFetchLimits = {
  timeoutMs: 8000,
  maxRedirects: 5,
  maxBytes: 1_000_000,
  acceptedContentTypes: null,
}

export interface SafeValidators {
  readonly etag: string | null
  readonly last_modified: string | null
  readonly origin?: string | null
}

export type ResponseBody = Uint8Array | AsyncIterable<Uint8Array> | null

export interface FetchInit {
  headers: Record<string, string>
  signal: AbortSignal
  connectIp: string
  servername: string
}

export interface FetchResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: ResponseBody
  readonly peerIp: string | null
}

export interface HttpTransport {
  fetch(url: string, init: FetchInit): Promise<FetchResponse>
  lookup(host: string): Promise<string[]>
}

export type SafeFetchFailure =
  | "TIMEOUT"
  | "REDIRECT_LIMIT"
  | "RESPONSE_TOO_LARGE"
  | "UNSUPPORTED_CONTENT_TYPE"
  | "NETWORK_ERROR"
  | "SECURITY_REJECTED"
  | "INVALID_URL"
  | "OUT_OF_SCOPE_REDIRECT"

export interface SafeRedirectPolicy {
  readonly maxRedirects: number
  readonly allowCrossOrigin: boolean
  readonly scopeOrigin?: string | null
  /**
   * Generic redirect-target guard (e.g. a path-prefix scope). Evaluated
   * BEFORE the redirect target is fetched; a false return yields
   * OUT_OF_SCOPE_REDIRECT without issuing the request. The fetcher owns no
   * domain scope semantics; callers supply them (discovery passes
   * isInScope for PAGE fetches, nothing for origin-level resources).
   */
  readonly isAllowedRedirect?: (url: string) => boolean
}

export interface SafeFetchOptions {
  readonly transport?: HttpTransport
  readonly limits?: Partial<SafeFetchLimits>
  readonly validators?: SafeValidators | null
  readonly redirectPolicy?: Partial<SafeRedirectPolicy>
  readonly userAgent?: string
  readonly now?: () => string
  readonly counters?: { requests: number }
}

export interface SafeFetchEvidence {
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly startedAt: string
  readonly completedAt: string
  readonly status: number | null
  readonly headers: Record<string, string>
  readonly contentType: string | null
  readonly etag: string | null
  readonly lastModified: string | null
  readonly body: Uint8Array | null
  readonly bodyBytes: number
  readonly bodyDigest: string | null
  readonly notModified: boolean
  readonly sentValidators: boolean
  readonly failure: SafeFetchFailure | null
  readonly redirectChain: ReadonlyArray<string>
  readonly outOfScopeRedirect: string | null
}

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" })

const pinnedFetch = (
  rawUrl: string,
  init: FetchInit,
  timeoutMs: number,
): Promise<FetchResponse> =>
  new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(rawUrl)
    } catch {
      reject(new Error("InvalidUrl"))
      return
    }
    const isTls = u.protocol === "https:"
    const port = u.port !== "" ? Number(u.port) : isTls ? 443 : 80
    const family = isIP(init.connectIp) === 6 ? 6 : 4
    const impl = isTls ? httpsRequest : httpRequest
    const req = impl(
      {
        host: init.connectIp,
        port,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        lookup: (_hostname: string, _options: unknown, callback: (err: null, address: string, family: number) => void) =>
          callback(null, init.connectIp, family),
        servername: isTls ? init.servername : undefined,
        headers: { host: u.host, ...init.headers, connection: "close" },
      },
      (res) => {
        const headers: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) {
          headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v ?? "")
        }
        resolve({
          status: res.statusCode ?? 0,
          headers,
          body: res,
          peerIp: req.socket?.remoteAddress ?? null,
        })
      },
    )
    req.on("error", reject)
    req.setTimeout(timeoutMs, () => req.destroy(abortError()))
    if (init.signal.aborted) {
      req.destroy(abortError())
      return
    }
    init.signal.addEventListener("abort", () => req.destroy(abortError()), { once: true })
    req.end()
  })

export const defaultTransport = (timeoutMs: number): HttpTransport => ({
  fetch: (url, init) => pinnedFetch(url, init, timeoutMs),
  lookup: async (host) => {
    if (isIP(host) !== 0) return [host]
    const records = await dnsLookupDefault(host, { all: true })
    return records.map((r) => r.address)
  },
})

const ipv4Parts = (ip: string): number[] | null => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return nums as number[]
}

const ipv4InCidr = (ip: string, base: string, bits: number): boolean => {
  const a = ipv4Parts(ip)
  const b = ipv4Parts(base)
  if (!a || !b) return false
  const toInt = (p: number[]) => ((p[0]! << 24) | (p[1]! << 16) | (p[2]! << 8) | p[3]!) >>> 0
  const mask = bits === 0 ? 0 : (~0 >>> (32 - bits)) << (32 - bits)
  return (toInt(a) & mask) === (toInt(b) & mask)
}

export const isForbiddenIp = (ip: string): boolean => {
  const v = ip.trim().toLowerCase()
  if (ipv4Parts(v) !== null) {
    if (v === "0.0.0.0") return true
    if (v.startsWith("127.")) return true
    if (ipv4InCidr(v, "10.0.0.0", 8)) return true
    if (ipv4InCidr(v, "172.16.0.0", 12)) return true
    if (ipv4InCidr(v, "192.168.0.0", 16)) return true
    if (ipv4InCidr(v, "169.254.0.0", 16)) return true
    if (ipv4InCidr(v, "224.0.0.0", 4)) return true
    if (v === "100.100.100.200") return true
    return false
  }
  const low = v.replace(/^\[(.*)\]$/, "$1")
  if (low === "::1" || low === "::") return true
  if (low === "::ffff:127.0.0.1") return true
  if (low.startsWith("fe80:") || low.startsWith("fe90:") || low.startsWith("fea") || low.startsWith("feb:")) return true
  if (low.startsWith("fc") || low.startsWith("fd")) return true
  if (low.startsWith("ff")) return true
  if (low.startsWith("::ffff:")) {
    const embedded = low.slice("::ffff:".length)
    if (ipv4Parts(embedded) !== null) return isForbiddenIp(embedded)
  }
  return false
}

export const originOf = (raw: string): string | null => {
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

export const readCapped = async (
  source: ResponseBody,
  ceiling: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
  if (source === null) return { bytes: new Uint8Array(0), truncated: false }
  if (source instanceof Uint8Array) {
    if (source.length > ceiling) return { bytes: source.slice(0, ceiling), truncated: true }
    return { bytes: source, truncated: false }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  const iter = source[Symbol.asyncIterator]()
  const abortRace =
    signal === undefined
      ? null
      : new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(abortError())
            return
          }
          signal.addEventListener("abort", () => reject(abortError()), { once: true })
        })
  const destroy = () => {
    const s = source as { destroy?: () => void; cancel?: () => void }
    try {
      s.destroy?.()
    } catch {
      // ignore
    }
    try {
      const r = iter.return?.()
      if (r !== undefined) void Promise.resolve(r).catch(() => undefined)
    } catch {
      // ignore
    }
  }
  try {
    while (true) {
      const next = iter.next()
      const result = abortRace === null ? await next : await Promise.race([next, abortRace])
      if (result.done === true) break
      const chunk = result.value as Uint8Array
      chunks.push(chunk)
      total += chunk.length
      if (total > ceiling) {
        destroy()
        return { bytes: concat(chunks).slice(0, ceiling), truncated: true }
      }
      if (signal?.aborted === true) {
        destroy()
        throw abortError()
      }
    }
  } catch (e) {
    destroy()
    throw e
  }
  return { bytes: concat(chunks), truncated: false }
}

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

const failEvidence = (args: {
  requestedUrl: string
  current: string
  startedAt: string
  completedAt: string
  status: number | null
  headers?: Record<string, string>
  failure: SafeFetchFailure
  redirectChain: string[]
  outOfScopeRedirect?: string | null
}): SafeFetchEvidence => ({
  requestedUrl: args.requestedUrl,
  finalUrl: args.current,
  startedAt: args.startedAt,
  completedAt: args.completedAt,
  status: args.status,
  headers: args.headers ?? {},
  contentType: args.headers?.["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? null,
  etag: args.headers?.["etag"] ?? null,
  lastModified: args.headers?.["last-modified"] ?? null,
  body: null,
  bodyBytes: 0,
  bodyDigest: null,
  notModified: false,
  sentValidators: false,
  failure: args.failure,
  redirectChain: args.redirectChain,
  outOfScopeRedirect: args.outOfScopeRedirect ?? null,
})

/** Core bounded fetch with full SSRF + redirect + ceiling enforcement. */
export const safeFetch = async (rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchEvidence> => {
  const limits: SafeFetchLimits = { ...DEFAULT_SAFE_LIMITS, ...options.limits }
  const transport = options.transport ?? defaultTransport(limits.timeoutMs)
  const now = options.now ?? (() => new Date().toISOString())
  const startedAt = now()
  const redirectPolicy: SafeRedirectPolicy = {
    maxRedirects: options.redirectPolicy?.maxRedirects ?? limits.maxRedirects,
    allowCrossOrigin: options.redirectPolicy?.allowCrossOrigin ?? true,
    scopeOrigin: options.redirectPolicy?.scopeOrigin ?? null,
    ...(options.redirectPolicy?.isAllowedRedirect !== undefined
      ? { isAllowedRedirect: options.redirectPolicy.isAllowedRedirect }
      : {}),
  }
  const validators = options.validators ?? null
  const userAgent = options.userAgent
  const counters = options.counters

  let current: string
  try {
    const parsed = new URL(rawUrl)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return failEvidence({ requestedUrl: rawUrl, current: rawUrl, startedAt, completedAt: now(), status: null, failure: "INVALID_URL", redirectChain: [] })
    }
    current = parsed.toString()
  } catch {
    return failEvidence({ requestedUrl: rawUrl, current: rawUrl, startedAt, completedAt: now(), status: null, failure: "INVALID_URL", redirectChain: [] })
  }
  const requestedUrl = current
  const validatorOrigin = validators?.origin ?? originOf(requestedUrl)
  let redirects = 0
  let finalUrl = requestedUrl
  const redirectChain: string[] = [requestedUrl]

  while (true) {
    let parsed: URL
    try {
      parsed = new URL(current)
    } catch {
      return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status: null, failure: "INVALID_URL", redirectChain })
    }
    const host = parsed.hostname
    const hopOrigin = originOf(current)
    const sameOrigin = hopOrigin !== null && validatorOrigin !== null && hopOrigin === validatorOrigin
    const conditional: Record<string, string> = {}
    if (sameOrigin && validators) {
      if (validators.etag) conditional["if-none-match"] = validators.etag
      if (validators.last_modified) conditional["if-modified-since"] = validators.last_modified
    }
    if (userAgent) conditional["user-agent"] = userAgent
    const sentValidators = Object.keys(conditional).some((k) => k === "if-none-match" || k === "if-modified-since")

    let addrs: string[]
    try {
      addrs = await transport.lookup(host)
    } catch {
      return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status: null, failure: "NETWORK_ERROR", redirectChain })
    }
    if (addrs.length === 0 || addrs.some(isForbiddenIp)) {
      return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status: null, failure: "SECURITY_REJECTED", redirectChain })
    }
    const connectIp = addrs[0]!
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), limits.timeoutMs)
    try {
      let res: FetchResponse
      try {
        if (counters) counters.requests += 1
        res = await transport.fetch(current, { headers: { ...conditional }, signal: controller.signal, connectIp, servername: host })
      } catch (e) {
        const name = (e as { name?: string }).name ?? ""
        return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status: null, failure: name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR", redirectChain })
      }
      if (res.peerIp !== null && (isForbiddenIp(res.peerIp) || !addrs.includes(res.peerIp))) {
        try {
          await readCapped(res.body, 0, controller.signal)
        } catch {
          // ignore drain errors
        }
        return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status: res.status, headers: res.headers, failure: "SECURITY_REJECTED", redirectChain })
      }
      let raw: Uint8Array
      try {
        const read = await readCapped(res.body, limits.maxBytes, controller.signal)
        if (read.truncated) {
          return {
            ...failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status: res.status, headers: res.headers, failure: "RESPONSE_TOO_LARGE", redirectChain }),
            contentType: res.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? null,
          }
        }
        raw = read.bytes
      } catch (e) {
        const name = (e as { name?: string }).name ?? ""
        return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status: res.status, failure: name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR", redirectChain })
      }
      const status = res.status
      if (status === 304) {
        if (!sentValidators) {
          return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status, failure: "NETWORK_ERROR", redirectChain })
        }
        return {
          requestedUrl,
          finalUrl,
          startedAt,
          completedAt: now(),
          status: 304,
          headers: res.headers,
          contentType: null,
          etag: validators?.etag ?? null,
          lastModified: validators?.last_modified ?? null,
          body: null,
          bodyBytes: 0,
          bodyDigest: null,
          notModified: true,
          sentValidators,
          failure: null,
          redirectChain,
          outOfScopeRedirect: null,
        }
      }
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        const location = res.headers["location"]
        if (location === undefined || location === "") {
          return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status, failure: "NETWORK_ERROR", redirectChain })
        }
        if (redirects >= redirectPolicy.maxRedirects) {
          return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status, failure: "REDIRECT_LIMIT", redirectChain })
        }
        let next: string
        try {
          next = new URL(location, current).toString()
          const proto = new URL(next).protocol
          if (proto !== "http:" && proto !== "https:") {
            return failEvidence({ requestedUrl, current: next, startedAt, completedAt: now(), status, failure: "SECURITY_REJECTED", redirectChain })
          }
        } catch {
          return failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status, failure: "NETWORK_ERROR", redirectChain })
        }
        // Discovery scope-bound policy: never follow cross-origin as content.
        if (!redirectPolicy.allowCrossOrigin) {
          const fromOrigin = originOf(current)
          const toOrigin = originOf(next)
          const inScope = fromOrigin !== null && toOrigin !== null && fromOrigin === toOrigin && (redirectPolicy.scopeOrigin === null || redirectPolicy.scopeOrigin === undefined || toOrigin === redirectPolicy.scopeOrigin)
          if (!inScope) {
            return {
              ...failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status, headers: res.headers, failure: "OUT_OF_SCOPE_REDIRECT", redirectChain }),
              outOfScopeRedirect: next,
            }
          }
        }
        // Generic caller-supplied target guard (e.g. path-prefix scope):
        // evaluated before the target is fetched, so a forbidden target is
        // never requested, not merely unmatched afterwards.
        if (redirectPolicy.isAllowedRedirect !== undefined && !redirectPolicy.isAllowedRedirect(next)) {
          return {
            ...failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status, headers: res.headers, failure: "OUT_OF_SCOPE_REDIRECT", redirectChain }),
            outOfScopeRedirect: next,
          }
        }
        redirects += 1
        current = next
        finalUrl = next
        redirectChain.push(next)
        continue
      }
      const contentType = res.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? null
      if (status < 200 || status >= 300) {
        // Error statuses carry no parseable representation: the outcome is
        // determined by status, never by a mismatched error-page content
        // type (e.g. a 404 text/html page is NOT_FOUND-equivalent transport
        // noise, not an unsupported document). The byte ceiling above still
        // applies uniformly to error bodies.
        return {
          ...failEvidence({ requestedUrl, current, startedAt, completedAt: now(), status, headers: res.headers, failure: "NETWORK_ERROR", redirectChain }),
          contentType,
        }
      }
      if (limits.acceptedContentTypes !== null && contentType !== null && !limits.acceptedContentTypes.some((a) => contentType === a)) {
        const completedAt = now()
        return {
          requestedUrl,
          finalUrl: current,
          startedAt,
          completedAt,
          status,
          headers: res.headers,
          contentType,
          etag: res.headers["etag"] ?? null,
          lastModified: res.headers["last-modified"] ?? null,
          body: null,
          bodyBytes: 0,
          bodyDigest: null,
          notModified: false,
          sentValidators,
          failure: "UNSUPPORTED_CONTENT_TYPE",
          redirectChain,
          outOfScopeRedirect: null,
        }
      }
      const completedAt = now()
      const digest = sha256Hex(raw)
      return {
        requestedUrl,
        finalUrl: current,
        startedAt,
        completedAt,
        status,
        headers: res.headers,
        contentType,
        etag: res.headers["etag"] ?? null,
        lastModified: res.headers["last-modified"] ?? null,
        body: raw,
        bodyBytes: raw.length,
        bodyDigest: digest,
        notModified: false,
        sentValidators,
        failure: null,
        redirectChain,
        outOfScopeRedirect: null,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

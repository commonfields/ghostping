// Native HTTP collector: ordinary GET with conditional requests,
// manual redirects, hard limits, and mandatory SSRF protection.
// Extension seam: PlaywrightCollector / FirecrawlCollector implement the
// same WebCollector interface without changing domain objects.

import { createHash } from "node:crypto"
import { lookup as dnsLookupDefault } from "node:dns/promises"
import { isIP } from "node:net"
import type { CollectionFailure, SourceObservationV1 } from "./types.js"

export interface CollectorLimits {
  readonly timeoutMs: number
  readonly maxRedirects: number
  readonly maxBytes: number
  readonly acceptedContentTypes: ReadonlyArray<string>
  readonly maxConcurrency: number
}

export const DEFAULT_LIMITS: CollectorLimits = {
  timeoutMs: 8000,
  maxRedirects: 5,
  maxBytes: 1_000_000,
  acceptedContentTypes: ["text/html", "application/xhtml+xml"],
  maxConcurrency: 4,
}

export interface CostCounters {
  requests: number
  notModified: number
  bytesDownloaded: number
  changed: number
  extractionsReran: number
}

export const createCounters = (): CostCounters => ({
  requests: 0,
  notModified: 0,
  bytesDownloaded: 0,
  changed: 0,
  extractionsReran: 0,
})

export interface PreviousValidators {
  readonly etag: string | null
  readonly last_modified: string | null
  readonly body_digest: string | null
}

export interface FetchResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: Uint8Array | null
}

export interface HttpTransport {
  fetch(url: string, init: { headers: Record<string, string>; signal: AbortSignal }): Promise<FetchResponse>
  lookup(host: string): Promise<string[]>
}

const defaultTransport = (): HttpTransport => ({
  fetch: async (url, init) => {
    const res = await fetch(url, { headers: init.headers, signal: init.signal, redirect: "manual" })
    const headers: Record<string, string> = {}
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    const buf = res.body === null ? null : new Uint8Array(await res.arrayBuffer())
    return { status: res.status, headers, body: buf }
  },
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

/** True when the literal IP must never be fetched. */
export const isForbiddenIp = (ip: string): boolean => {
  const v = ip.trim().toLowerCase()
  // IPv4
  if (ipv4Parts(v) !== null) {
    if (v === "0.0.0.0") return true
    if (v.startsWith("127.")) return true
    if (ipv4InCidr(v, "10.0.0.0", 8)) return true
    if (ipv4InCidr(v, "172.16.0.0", 12)) return true
    if (ipv4InCidr(v, "192.168.0.0", 16)) return true
    if (ipv4InCidr(v, "169.254.0.0", 16)) return true
    if (ipv4InCidr(v, "224.0.0.0", 4)) return true
    if (v === "100.100.100.200") return true // cloud metadata (Alibaba)
    return false
  }
  // IPv6 (normalized forms)
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

export interface WebCollector {
  collect(
    target: { readonly id: string; readonly business_id: string; readonly url: string },
    previous?: PreviousValidators | null,
  ): Promise<CollectorOutcome>
}

export interface CollectorOutcome {
  readonly observation: Omit<SourceObservationV1, "id" | "business_id" | "source_target_id" | "created_at">
  readonly body: string | null
  readonly reusedDigest: string | null
}

export interface NativeCollectorOptions {
  readonly transport?: HttpTransport
  readonly limits?: Partial<CollectorLimits>
  readonly counters?: CostCounters
  readonly now?: () => string
  readonly collectorVersion?: string
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

export class NativeHttpCollector implements WebCollector {
  private readonly transport: HttpTransport
  private readonly limits: CollectorLimits
  readonly counters: CostCounters
  private readonly now: () => string
  private readonly version: string

  constructor(options: NativeCollectorOptions = {}) {
    this.transport = options.transport ?? defaultTransport()
    this.limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.counters = options.counters ?? createCounters()
    this.now = options.now ?? (() => new Date().toISOString())
    this.version = options.collectorVersion ?? "native-http/1"
  }

  async collect(
    target: { readonly id: string; readonly business_id: string; readonly url: string },
    previous?: PreviousValidators | null,
  ): Promise<CollectorOutcome> {
    const started = this.now()
    let current: string
    try {
      const parsed = new URL(target.url)
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return this.failed(target, target.url, target.url, started, null, null, "INVALID_URL")
      }
      current = parsed.toString()
    } catch {
      return this.failed(target, target.url, target.url, started, null, null, "INVALID_URL")
    }
    const requestedUrl = current
    let redirects = 0
    let finalUrl = requestedUrl
    // Conditional headers persist across redirects (re-applied to same-origin only;
    // V1 reapplies to every hop because validators are origin-scoped by the server).
    const conditional: Record<string, string> = {}
    if (previous?.etag) conditional["if-none-match"] = previous.etag
    if (previous?.last_modified) conditional["if-modified-since"] = previous.last_modified

    while (true) {
      const host = (() => {
        try {
          return new URL(current).hostname
        } catch {
          return null
        }
      })()
      if (host === null) return this.failed(target, requestedUrl, current, started, null, null, "INVALID_URL")
      // DNS + SSRF validation before every request, including redirects.
      let addrs: string[]
      try {
        addrs = await this.transport.lookup(host)
      } catch {
        return this.failed(target, requestedUrl, current, started, null, null, "NETWORK_ERROR")
      }
      if (addrs.length === 0 || addrs.some(isForbiddenIp)) {
        return this.failed(target, requestedUrl, current, started, null, null, "SECURITY_REJECTED")
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs)
      let res: FetchResponse
      try {
        this.counters.requests += 1
        res = await this.transport.fetch(current, { headers: { ...conditional }, signal: controller.signal })
      } catch (e) {
        clearTimeout(timer)
        const name = (e as { name?: string }).name ?? ""
        return this.failed(target, requestedUrl, current, started, null, null, name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR")
      } finally {
        clearTimeout(timer)
      }
      const status = res.status
      if (status === 304) {
        this.counters.notModified += 1
        const completed = this.now()
        return {
          observation: {
            collector: "NATIVE_HTTP",
            collector_version: this.version,
            requested_url: requestedUrl,
            final_url: finalUrl,
            started_at: started,
            completed_at: completed,
            http_status: 304,
            content_type: null,
            etag: previous?.etag ?? null,
            last_modified: previous?.last_modified ?? null,
            body_digest: previous?.body_digest ?? null,
            body_bytes: 0,
            collection_state: "NOT_MODIFIED",
            failure: null,
            raw_evidence_id: null,
          },
          body: null,
          reusedDigest: previous?.body_digest ?? null,
        }
      }
      if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
        const location = res.headers["location"]
        if (location === undefined || location === "") {
          return this.failed(target, requestedUrl, current, started, status, null, "NETWORK_ERROR")
        }
        if (redirects >= this.limits.maxRedirects) {
          return this.failed(target, requestedUrl, current, started, status, null, "REDIRECT_LIMIT")
        }
        let next: string
        try {
          next = new URL(location, current).toString()
          const proto = new URL(next).protocol
          if (proto !== "http:" && proto !== "https:") {
            return this.failed(target, requestedUrl, next, started, status, null, "SECURITY_REJECTED")
          }
        } catch {
          return this.failed(target, requestedUrl, current, started, status, null, "NETWORK_ERROR")
        }
        redirects += 1
        current = next
        finalUrl = next
        continue
      }
      const contentType = res.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? null
      if (contentType !== null && !this.limits.acceptedContentTypes.some((a) => contentType === a || contentType.startsWith(`${a};`))) {
        // Strict accept list; record failure, do not treat as source absence.
        const completed = this.now()
        return {
          observation: {
            collector: "NATIVE_HTTP",
            collector_version: this.version,
            requested_url: requestedUrl,
            final_url: current,
            started_at: started,
            completed_at: completed,
            http_status: status,
            content_type: contentType,
            etag: res.headers["etag"] ?? null,
            last_modified: res.headers["last-modified"] ?? null,
            body_digest: null,
            body_bytes: 0,
            collection_state: "FAILED",
            failure: "UNSUPPORTED_CONTENT_TYPE",
            raw_evidence_id: null,
          },
          body: null,
          reusedDigest: null,
        }
      }
      const body = res.body ?? new Uint8Array(0)
      if (body.length > this.limits.maxBytes) {
        return this.failed(target, requestedUrl, current, started, status, contentType, "RESPONSE_TOO_LARGE")
      }
      if (status < 200 || status >= 300) {
        return this.failed(target, requestedUrl, current, started, status, contentType, "NETWORK_ERROR")
      }
      const completed = this.now()
      const digest = sha256Hex(body)
      this.counters.bytesDownloaded += body.length
      const text = Buffer.from(body).toString("utf8")
      return {
        observation: {
          collector: "NATIVE_HTTP",
          collector_version: this.version,
          requested_url: requestedUrl,
          final_url: current,
          started_at: started,
          completed_at: completed,
          http_status: status,
          content_type: contentType,
          etag: res.headers["etag"] ?? null,
          last_modified: res.headers["last-modified"] ?? null,
          body_digest: digest,
          body_bytes: body.length,
          collection_state: "FETCHED",
          failure: null,
          raw_evidence_id: null,
        },
        body: text,
        reusedDigest: null,
      }
    }
  }

  private failed(
    target: { readonly url: string },
    requestedUrl: string,
    finalUrl: string,
    started: string,
    status: number | null,
    contentType: string | null,
    failure: CollectionFailure,
  ): CollectorOutcome {
    void target
    return {
      observation: {
        collector: "NATIVE_HTTP",
        collector_version: this.version,
        requested_url: requestedUrl,
        final_url: finalUrl,
        started_at: started,
        completed_at: this.now(),
        http_status: status,
        content_type: contentType,
        etag: null,
        last_modified: null,
        body_digest: null,
        body_bytes: 0,
        collection_state: "FAILED",
        failure,
        raw_evidence_id: null,
      },
      body: null,
      reusedDigest: null,
    }
  }
}

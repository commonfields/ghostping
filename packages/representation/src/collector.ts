// Native HTTP collector: ordinary GET with conditional requests,
// manual redirects, hard limits, and mandatory SSRF protection.
// Extension seam: PlaywrightCollector / FirecrawlCollector implement the
// same WebCollector interface without changing domain objects.
//
// SSRF model (defense in depth):
// 1. DNS preflight: resolve the hop hostname, reject when the answer set is
//    empty or contains ANY forbidden literal (localhost, loopback, RFC1918,
//    link-local, multicast, cloud metadata, non-IPv4/IPv6 handled below).
// 2. IP pinning: the connection opens against the exact validated IP
//    (connectIp), never by re-resolving the hostname at connect time, so a
//    rebind between lookup and connect cannot steer the socket. TLS keeps
//    SNI + hostname certificate verification via `servername`.
// 3. Connect-time check: the transport reports the actual peer IP; the
//    collector rejects when it is forbidden or outside the validated set.
// DNS preflight alone is NOT sufficient; (2) and (3) are enforced.

import { createHash } from "node:crypto"
import { lookup as dnsLookupDefault } from "node:dns/promises"
import { isIP } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
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
  /** Origin (scheme://host[:port]) the validators were collected from. */
  readonly origin?: string | null
}

/** Response bodies may stream; the collector always drains them through a
 * hard byte ceiling, including error and unsupported-type responses. */
export type ResponseBody = Uint8Array | AsyncIterable<Uint8Array> | null

export interface FetchInit {
  headers: Record<string, string>
  signal: AbortSignal
  /** Exact validated IP to connect to (pinned; no re-resolution). */
  connectIp: string
  /** Original hostname for SNI Host verification and Host header. */
  servername: string
}

export interface FetchResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: ResponseBody
  /** Actual connected peer IP, or null when the transport cannot report it
   * (explicit test harnesses only; production always reports). */
  readonly peerIp: string | null
}

export interface HttpTransport {
  fetch(url: string, init: FetchInit): Promise<FetchResponse>
  lookup(host: string): Promise<string[]>
}

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" })

/** Production transport: DNS via lookup(), then a pinned IP connection.
 * The socket dials connectIp literally; TLS verifies the certificate
 * against servername (the original hostname). */
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
        // Belt and braces: even if Node ever resolved here, it may only use
        // the pinned address.
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

const defaultTransport = (timeoutMs: number): HttpTransport => ({
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

/** Normalized origin for validator scoping; null when unparseable. */
export const originOf = (raw: string): string | null => {
  try {
    return new URL(raw).origin
  } catch {
    return null
  }
}

/**
 * Drain a body through a hard byte ceiling. Reads at most ceiling+1 bytes;
 * anything beyond is discarded and reported as truncated. The ceiling
 * applies uniformly to success, error, and unsupported-type bodies.
 * Aborts promptly on signal (slow/endless bodies become AbortError).
 */
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
      // ignore cleanup errors
    }
    try {
      const r = iter.return?.()
      if (r !== undefined) void Promise.resolve(r).catch(() => undefined)
    } catch {
      // ignore cleanup errors
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
    const limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.transport = options.transport ?? defaultTransport(limits.timeoutMs)
    this.limits = limits
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
    // Validators belong to the resource/origin they were collected from.
    // They are sent only to that same origin; any cross-origin hop drops
    // them (servers must not receive another origin's cache validators).
    const validatorOrigin = previous?.origin ?? originOf(requestedUrl)
    let redirects = 0
    let finalUrl = requestedUrl

    while (true) {
      let parsed: URL
      try {
        parsed = new URL(current)
      } catch {
        return this.failed(target, requestedUrl, current, started, null, null, "INVALID_URL")
      }
      const host = parsed.hostname
      const hopOrigin = originOf(current)
      const sameOrigin = hopOrigin !== null && validatorOrigin !== null && hopOrigin === validatorOrigin
      const conditional: Record<string, string> = {}
      if (sameOrigin) {
        if (previous?.etag) conditional["if-none-match"] = previous.etag
        if (previous?.last_modified) conditional["if-modified-since"] = previous.last_modified
      }
      const sentValidators = Object.keys(conditional).length > 0
      // DNS preflight + SSRF validation before every request hop.
      let addrs: string[]
      try {
        addrs = await this.transport.lookup(host)
      } catch {
        return this.failed(target, requestedUrl, current, started, null, null, "NETWORK_ERROR")
      }
      if (addrs.length === 0 || addrs.some(isForbiddenIp)) {
        return this.failed(target, requestedUrl, current, started, null, null, "SECURITY_REJECTED")
      }
      // Pin to the exact validated address; the transport must dial it.
      const connectIp = addrs[0]!
      // One deadline covers connect + headers + the full streamed body, so
      // slow/endless bodies time out instead of hanging the collection.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.limits.timeoutMs)
      try {
        let res: FetchResponse
        try {
          this.counters.requests += 1
          res = await this.transport.fetch(current, {
            headers: { ...conditional },
            signal: controller.signal,
            connectIp,
            servername: host,
          })
        } catch (e) {
          const name = (e as { name?: string }).name ?? ""
          return this.failed(target, requestedUrl, current, started, null, null, name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR")
        }
      // Connect-time check: the peer must be one of the validated addresses
      // and never forbidden. Catches DNS-rebind races and transports that
      // stray from the pinned address.
      if (res.peerIp !== null && (isForbiddenIp(res.peerIp) || !addrs.includes(res.peerIp))) {
          try {
            await readCapped(res.body, 0, controller.signal)
          } catch {
            // ignore drain errors on a rejected connection
          }
          return this.failed(target, requestedUrl, current, started, res.status, null, "SECURITY_REJECTED")
        }
      // Stream through the hard ceiling first: the same limit guards
      // success, error, and unsupported-type bodies alike.
      const ceiling = this.limits.maxBytes + 1
      let raw: Uint8Array
      try {
        const read = await readCapped(res.body, ceiling, controller.signal)
        if (read.truncated) {
          return this.failed(target, requestedUrl, current, started, res.status, res.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? null, "RESPONSE_TOO_LARGE")
        }
        raw = read.bytes
      } catch (e) {
        const name = (e as { name?: string }).name ?? ""
        return this.failed(target, requestedUrl, current, started, res.status, null, name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR")
      }
      const status = res.status
      if (status === 304) {
        if (!sentValidators) {
          // A 304 without validators is a protocol violation; never treat
          // it as reuse evidence.
          return this.failed(target, requestedUrl, current, started, status, null, "NETWORK_ERROR")
        }
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
      if (status < 200 || status >= 300) {
        return this.failed(target, requestedUrl, current, started, status, contentType, "NETWORK_ERROR")
      }
      const completed = this.now()
      const digest = sha256Hex(raw)
      this.counters.bytesDownloaded += raw.length
      const text = Buffer.from(raw).toString("utf8")
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
          body_bytes: raw.length,
          collection_state: "FETCHED",
          failure: null,
          raw_evidence_id: null,
        },
        body: text,
        reusedDigest: null,
      }
      } finally {
        clearTimeout(timer)
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

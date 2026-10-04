// Native HTTP collector: thin domain wrapper over the shared SafeHttpFetcher.
// Security logic lives in ./safe-http.js; this file maps generic evidence
// to SourceObservationV1 rows. No fetch path may bypass safeFetch.

import {
  defaultTransport,
  isForbiddenIp,
  originOf,
  readCapped,
  safeFetch,
  type FetchInit,
  type FetchResponse,
  type HttpTransport,
  type ResponseBody,
  type SafeValidators,
} from "./safe-http.js"
import type { CollectionFailure, SourceObservationV1 } from "./types.js"

export type { FetchInit, FetchResponse, HttpTransport, ResponseBody }
export { defaultTransport, isForbiddenIp, originOf, readCapped }

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
  readonly origin?: string | null
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

export class NativeHttpCollector implements WebCollector {
  private readonly transport: HttpTransport | undefined
  private readonly limits: CollectorLimits
  readonly counters: CostCounters
  private readonly now: () => string
  private readonly version: string

  constructor(options: NativeCollectorOptions = {}) {
    const limits = { ...DEFAULT_LIMITS, ...options.limits }
    this.transport = options.transport
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
    const validators: SafeValidators | null =
      previous == null
        ? null
        : { etag: previous.etag, last_modified: previous.last_modified, origin: previous.origin ?? null }
    const ev = await safeFetch(target.url, {
      ...(this.transport ? { transport: this.transport } : {}),
      limits: {
        timeoutMs: this.limits.timeoutMs,
        maxRedirects: this.limits.maxRedirects,
        maxBytes: this.limits.maxBytes,
        acceptedContentTypes: [...this.limits.acceptedContentTypes],
      },
      validators,
      redirectPolicy: { maxRedirects: this.limits.maxRedirects, allowCrossOrigin: true },
      now: this.now,
      counters: this.counters,
    })

    // Map generic evidence to representation observations, preserving
    // exact legacy semantics (INVALID_URL, 304 reuse, content-type gate).
    if (ev.failure === "INVALID_URL") {
      return this.failed(target, target.url, target.url, started, null, null, "INVALID_URL")
    }
    if (ev.notModified) {
      this.counters.notModified += 1
      return {
        observation: {
          collector: "NATIVE_HTTP",
          collector_version: this.version,
          requested_url: ev.requestedUrl,
          final_url: ev.finalUrl,
          started_at: ev.startedAt,
          completed_at: ev.completedAt,
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
    if (ev.failure !== null) {
      const mapped: CollectionFailure =
        ev.failure === "OUT_OF_SCOPE_REDIRECT" ? "SECURITY_REJECTED" : (ev.failure as CollectionFailure)
      // Preserve legacy classification: unsupported-type keeps headers,
      // oversized keeps status+content-type, redirect-limit keeps status.
      if (ev.failure === "UNSUPPORTED_CONTENT_TYPE") {
        return {
          observation: {
            collector: "NATIVE_HTTP",
            collector_version: this.version,
            requested_url: ev.requestedUrl,
            final_url: ev.finalUrl,
            started_at: ev.startedAt,
            completed_at: ev.completedAt,
            http_status: ev.status,
            content_type: ev.contentType,
            etag: ev.etag,
            last_modified: ev.lastModified,
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
      return this.failed(target, ev.requestedUrl, ev.finalUrl, started, ev.status, ev.contentType, mapped)
    }
    // Success: decode + digest + byte accounting.
    const raw = ev.body ?? new Uint8Array(0)
    this.counters.bytesDownloaded += raw.length
    const text = Buffer.from(raw).toString("utf8")
    return {
      observation: {
        collector: "NATIVE_HTTP",
        collector_version: this.version,
        requested_url: ev.requestedUrl,
        final_url: ev.finalUrl,
        started_at: ev.startedAt,
        completed_at: ev.completedAt,
        http_status: ev.status,
        content_type: ev.contentType,
        etag: ev.etag,
        last_modified: ev.lastModified,
        body_digest: ev.bodyDigest,
        body_bytes: raw.length,
        collection_state: "FETCHED",
        failure: null,
        raw_evidence_id: null,
      },
      body: text,
      reusedDigest: null,
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

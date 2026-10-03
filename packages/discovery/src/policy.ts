// Scope policy V1: origin + path-prefix subtree, query gating by provenance.
// Pure functions; no network, no storage.

import type { DiscoveredVia } from "./types.js"
import { POLICY_VERSION } from "./types.js"

export { POLICY_VERSION }

export class DiscoveryScopeInvalid extends Error {
  constructor(
    readonly code: "INVALID_URL" | "UNSUPPORTED_SCHEME" | "CREDENTIALS_REJECTED" | "EMPTY_HOST",
    detail?: string,
  ) {
    super(detail === undefined ? `DiscoveryScopeInvalid: ${code}` : `DiscoveryScopeInvalid: ${code}: ${detail}`)
    this.name = "DiscoveryScopeInvalid"
  }
}

export interface ValidatedScope {
  readonly canonical_origin: string
  readonly path_prefix: string
}

const stripDefaultPort = (scheme: string, port: string): string => {
  if ((scheme === "http:" && port === "80") || (scheme === "https:" && port === "443")) return ""
  return port
}

/** Canonical origin: lowercase scheme + host, default ports stripped. */
export const canonicalOriginOf = (u: URL): string => {
  const scheme = u.protocol.toLowerCase()
  const host = u.hostname.toLowerCase()
  const port = stripDefaultPort(scheme, u.port)
  return `${scheme}//${host}${port === "" ? "" : `:${port}`}`
}

/**
 * Validate an operator-supplied scope root URL.
 * Accepts http/https only; rejects embedded credentials and every other
 * scheme (file/ftp/javascript/data/...). Returns the canonical origin and
 * the path prefix that bounds the crawl subtree.
 */
export const validateScope = (rootUrl: string): ValidatedScope => {
  let u: URL
  try {
    u = new URL(rootUrl)
  } catch {
    throw new DiscoveryScopeInvalid("INVALID_URL", rootUrl)
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new DiscoveryScopeInvalid("UNSUPPORTED_SCHEME", rootUrl)
  }
  if (u.username !== "" || u.password !== "") {
    throw new DiscoveryScopeInvalid("CREDENTIALS_REJECTED", rootUrl)
  }
  if (u.hostname === "") throw new DiscoveryScopeInvalid("EMPTY_HOST", rootUrl)
  let prefix = u.pathname || "/"
  if (prefix.length > 1 && prefix.endsWith("/")) prefix = prefix.slice(0, -1)
  return { canonical_origin: canonicalOriginOf(u), path_prefix: prefix }
}

/** Same-origin + path-prefix subtree check. http/https only. */
export const isInScope = (
  rawUrl: string,
  scope: { readonly canonical_origin: string; readonly path_prefix: string },
): boolean => {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false
  if (canonicalOriginOf(u) !== scope.canonical_origin) return false
  if (scope.path_prefix === "/") return true
  const path = u.pathname || "/"
  return path === scope.path_prefix || path.startsWith(`${scope.path_prefix}/`)
}

/**
 * Query-URL gating by provenance. Sitemap and root identities keep their
 * query (distinct canonical identities). Link-discovered URLs with a query
 * are recorded and skipped (QUERY_LINK_SKIPPED), never stripped-and-crawled.
 */
export const isQueryAllowed = (rawUrl: string, discoveredVia: DiscoveredVia): boolean => {
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (u.search === "") return true
  return discoveredVia !== "LINK"
}

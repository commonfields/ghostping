// Deterministic URL canonicalization for citation association.
// Conservative: scheme/host lowercase, default ports stripped, fragment
// dropped, trailing-slash policy, query preserved exactly. Any ambiguity
// means do not link.

export const normalizeUrl = (raw: string): string | null => {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null
  const scheme = u.protocol.toLowerCase()
  const host = u.hostname.toLowerCase()
  if (host.length === 0) return null
  let port = u.port
  if ((scheme === "http:" && port === "80") || (scheme === "https:" && port === "443")) port = ""
  let path = u.pathname || "/"
  // Trailing-slash policy: "/" stays "/", otherwise strip single trailing slash.
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1)
  const search = u.search // preserved exactly; never stripped
  return `${scheme}//${host}${port === "" ? "" : `:${port}`}${path}${search}`
}

/** Canonical equivalence: both normalize and string-compare. */
export const sameCanonicalUrl = (a: string, b: string): boolean => {
  const na = normalizeUrl(a)
  const nb = normalizeUrl(b)
  if (na === null || nb === null) return false
  return na === nb
}

// First-party auth: scrypt password hashing (Node crypto, well-maintained
// stdlib) + server-side sessions + HttpOnly SameSite=Lax cookies.
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

export const hashPassword = (password: string): string => {
  if (password.length < 8) throw new Error("InvalidFactValue: password too short")
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 32).toString("hex")
  return `scrypt$16384$8$1$${salt}$${hash}`
}

export const verifyPassword = (password: string, stored: string): boolean => {
  const parts = stored.split("$")
  if (parts.length !== 6 || parts[0] !== "scrypt") return false
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string]
  const derived = scryptSync(password, salt as string, 32).toString("hex")
  const a = Buffer.from(derived, "hex")
  const b = Buffer.from(hash as string, "hex")
  void n
  void r
  void p
  return a.length === b.length && timingSafeEqual(a, b)
}

export const SESSION_COOKIE = "or_session"

export const parseCookies = (header: string | null): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i === -1) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export const sessionCookieHeader = (sessionId: string, secure: boolean): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax${
    secure ? "; Secure" : ""
  }; Max-Age=2592000`

export const clearedCookieHeader = (): string =>
  `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

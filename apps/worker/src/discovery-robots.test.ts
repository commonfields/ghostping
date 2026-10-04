// Robots fetch boundary: content-type fail-closed, redirect scope rules.
// Stub-transport tests against the real makeRobotsFetcher + safeFetch path
// (no network, loopback never touched: TEST-NET addresses only).
import { describe, expect, it } from "vitest"
import type { FetchResponse, HttpTransport } from "@ghostping/representation"
import { fetchAndParseRobots } from "@ghostping/discovery"
import { makeRobotsFetcher } from "./discovery-runner.js"

const PEER = "93.184.216.34"
const ORIGIN = "https://acme.example"

const stubTransport = (routes: Record<string, { status: number; headers: Record<string, string>; body: string }>): HttpTransport => ({
  lookup: async () => [PEER],
  fetch: async (url, init): Promise<FetchResponse> => {
    const path = new URL(url).pathname
    const r = routes[path]
    if (!r) return { status: 404, headers: {}, body: new Uint8Array(0), peerIp: PEER }
    void init
    return { status: r.status, headers: r.headers, body: new TextEncoder().encode(r.body), peerIp: PEER }
  },
})

const outcome = (routes: Record<string, { status: number; headers: Record<string, string>; body: string }>) =>
  fetchAndParseRobots(ORIGIN, makeRobotsFetcher(ORIGIN, stubTransport(routes)))

describe("robots fetch boundary", () => {
  it("200 text/plain valid robots parses", async () => {
    const o = await outcome({ "/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /private/\n" } })
    expect(o.state).toBe("PARSED")
    if (o.state === "PARSED") expect(o.rules.disallows).toEqual(["/private/"])
  })

  it("200 text/plain empty allows per empty rules", async () => {
    const o = await outcome({ "/robots.txt": { status: 200, headers: { "content-type": "text/plain" }, body: "" } })
    expect(o.state).toBe("PARSED")
    if (o.state === "PARSED") expect(o.rules.disallows).toEqual([])
  })

  it("200 text/html fails closed (UNAVAILABLE, never allow-all)", async () => {
    const o = await outcome({ "/robots.txt": { status: 200, headers: { "content-type": "text/html" }, body: "<html><body>challenge</body></html>" } })
    expect(o.state).toBe("UNAVAILABLE")
  })

  it("200 application/json fails closed", async () => {
    const o = await outcome({ "/robots.txt": { status: 200, headers: { "content-type": "application/json" }, body: "{}" } })
    expect(o.state).toBe("UNAVAILABLE")
  })

  it("404 -> NO_FILE, 403 -> DENIED, 500 -> UNAVAILABLE", async () => {
    expect((await outcome({})).state).toBe("NO_FILE")
    expect((await outcome({ "/robots.txt": { status: 403, headers: {}, body: "" } })).state).toBe("DENIED")
    expect((await outcome({ "/robots.txt": { status: 500, headers: {}, body: "" } })).state).toBe("UNAVAILABLE")
  })

  it("missing Content-Type retains pass-through behavior", async () => {
    const o = await outcome({ "/robots.txt": { status: 200, headers: {}, body: "User-agent: *\nDisallow: /x/\n" } })
    expect(o.state).toBe("PARSED")
    if (o.state === "PARSED") expect(o.rules.disallows).toEqual(["/x/"])
  })

  it("cross-origin redirect is never followed (UNAVAILABLE)", async () => {
    const o = await outcome({
      "/robots.txt": { status: 302, headers: { location: "https://other.example/robots.txt" }, body: "" },
    })
    expect(o.state).toBe("UNAVAILABLE")
  })

  it("same-origin redirect is followed when otherwise valid", async () => {
    const o = await outcome({
      "/robots.txt": { status: 302, headers: { location: "/robots-final.txt" }, body: "" },
      "/robots-final.txt": { status: 200, headers: { "content-type": "text/plain" }, body: "User-agent: *\nDisallow: /y/\n" },
    })
    expect(o.state).toBe("PARSED")
    if (o.state === "PARSED") expect(o.rules.disallows).toEqual(["/y/"])
  })
})

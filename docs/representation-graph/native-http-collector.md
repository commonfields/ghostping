# Native HTTP Collector

GET + manual redirects (5), timeout 8000ms, max 1MiB, accepted
`text/html` / `application/xhtml+xml`. ETag / Last-Modified conditional
requests; 304 → NOT_MODIFIED with digest reuse, no duplicate bytes.

## SSRF: pinned connections, not just DNS preflight

DNS preflight alone cannot stop rebinding, so the collector pins:

1. Preflight: resolve the hop hostname; reject empty sets or any
   forbidden literal (localhost, loopback, RFC1918, link-local,
   multicast, cloud metadata).
2. Pinning: the socket dials the exact validated IP (`connectIp`).
   The hostname is never re-resolved at connect time. TLS keeps SNI
   plus hostname certificate verification (`servername`); the HTTP
   `Host` header carries the original host.
3. Connect-time check: the transport reports the actual peer IP and
   the collector rejects peers that are forbidden or outside the
   validated set (`SECURITY_REJECTED`).

## Streaming byte ceiling

Bodies stream through `readCapped` with a hard `maxBytes + 1` ceiling:
reading stops and aborts past the ceiling, so arbitrarily large or
endless bodies can never be buffered whole (`RESPONSE_TOO_LARGE`).
The same ceiling guards success, error, and unsupported-type bodies.
One deadline covers connect + headers + the full streamed body, so
slow/hanging bodies end in `TIMEOUT`, never a hang.

## Validator scoping

`If-None-Match` / `If-Modified-Since` belong to the origin they were
collected from. Any cross-origin redirect hop drops them; a 304 that
arrives where no validators were sent is rejected as a protocol
violation, never treated as reuse evidence.

Future PlaywrightCollector / FirecrawlCollector implement `WebCollector`
without changing SourceTarget / Observation / Value / Finding.

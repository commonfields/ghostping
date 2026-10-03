# Native HTTP Collector

GET + manual redirects (5), timeout 8000ms, max 1MiB, accepted
`text/html` / `application/xhtml+xml`. ETag / Last-Modified conditional
requests; 304 → NOT_MODIFIED with digest reuse, no duplicate bytes.

Future PlaywrightCollector / FirecrawlCollector implement `WebCollector`
without changing SourceTarget / Observation / Value / Finding.

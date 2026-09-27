# Test fixtures — provenance and limits

All files in this directory are **synthetic shapes for parser tests**.
None is a genuine authorized Google export, and none has been near a real
Search Console property.

- `gsc_queries.csv`, `gsc_pages.csv` — ordinary Search export *shapes*
  (`Top queries` title line, `Query,Clicks,Impressions,CTR,Position`
  headers). Real authorized exports share this layout; cell values here are
  invented.
- `gsc_ai_search_synthetic.csv` — documents the *dimension set* Google
  describes for Generative AI Search reports (page/impressions with
  country/device, no clicks/CTR), assembled from public documentation only.
  Google's actual AI-report CSV layout is **UNVERIFIED**: no genuine
  authorized sample was available, so the AI importer path
  (`parse_ai_csv`, `--report generative-ai-search|generative-ai-discover`)
  is marked UNVERIFIED in code, reports, and docs. Do not present results
  from this fixture as measured AI exposure.
- `gemini_grounded.json`, `gemini_ungrounded.json` — synthetic
  `generateContent` response shapes exercising the grounded adapter
  (chunks, spans, empty metadata). Not real API responses.

Rules for contributors: never commit a real export, key, or property name
here. If a genuine authorized AI-report sample becomes available, validate
`parse_ai_csv` against it and remove the UNVERIFIED marking with evidence.

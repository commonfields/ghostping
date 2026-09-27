# Observation integrity (kernel V1 repairs)

What was wrong, what changed, and what remains unverified. Raw historical
evidence is never rewritten anywhere in this note's scope.

## 1. Google data provenance

**Defect:** the V1 generic CSV parser accepted any `Top queries`-shaped
export as first-party evidence with no report identity, so ordinary Search
data could flow into generative-AI metrics without any marker.

**Repair:**
- Explicit `ReportIdentity`: `generic_search`, `generative_ai_search`,
  `generative_ai_discover`, `unknown` (stored per observation; `unknown`
  default for pre-identity rows).
- The AI parser rejects clicks/CTR columns, `query` dimensions, and
  `device` for Discover (per Google's published dimension set). Ordinary
  exports MUST NOT enter AI metrics — enforced in code, not policy.
- Pre-identity rows stay intact; views overlay `unknown`+clicks as generic
  for display. Only `is_confirmed_ai()` identities feed AI sections.

**Limitation (UNVERIFIED):** Google publishes no authorized AI-report CSV
sample and no cryptographic origin for exports. The AI shape is assembled
from public documentation (impressions/pages/countries/devices/dates, no
clicks). A `--report` declaration stays a user declaration. See
`tests/fixtures/README.md`. If a genuine sample appears, validate
`parse_ai_csv` against it and drop the UNVERIFIED marking with evidence.

**Export behavior note:** Search Console renders unavailable CTR/position
cells empty in CSV exports. Empty stays NULL (unknown); explicit `0`/`0%`
is an observed zero. Some UI views render unavailable as 0 — exports are
authoritative, not the UI.

## 2. Aggregation and import atomicity

**Defects:** (a) views could sum across breakdowns; (b) batch/rows persisted
non-atomically; (c) per-row synthetic `raw` text replaced file bytes;
(d) same file bytes for another date silently skipped.

**Repairs:**
- Views report per-breakdown slices only; no cross-kind totals exist.
- `import_transaction` (BEGIN IMMEDIATE/COMMIT/ROLLBACK): parse + validate
  everything first, then persist batch + raw + rows atomically. Failed
  imports leave zero rows and no batch record; retry is safe.
- Whole file bytes stored content-addressed once; every observation's
  `raw_digest` pins them. Row detail lives in `payload.raw`, not in a
  reconstructed string.
- Batch key is now (project, kind, digest, identity, period) with a table
  rebuild migration for v1 databases. Same natural key + different
  measurements → first kept + `Integrity` observation + CLI warning.
  Same bytes + different period/identity → independent batch.

## 3. Gemini citation integrity

**Defect:** URI-less chunks were dropped, shifting every later index while
`groundingSupports` kept original positions — spans linked to the wrong
source, including out-of-range indices resolving who-knows-where.

**Repair:** position-preserved `sources: Vec<Option<GroundingSource>>`;
`resolved_citations()` resolves original indices with explicit unknown
attribution for invalid/URI-less references (never a neighbour's link).
Also: multi-part text concatenated (was parts[0] only); metadata-present-
but-useless is now `Unknown`, not `Parametric`; span text/offsets validated
Unicode-safely with integrity flags; response model identity preserved;
requested tool vs observed evidence separated in recorded payloads.

## 4. Report correctness

`observations report` prints, in order: conventional Search, AI Search
(UNVERIFIED badge), AI Discover (UNVERIFIED badge), unverified-origin rows,
retrieval split (grounded/parametric/unknown), inspectable native citations
(✓/⚠ per span), integrity flags, provenance split (surface × provider ×
model), sampled audits with per-run mock tags. No pooled rates, no scores,
no causal claims. Zero-evidence states exit 0 with guidance.

## 5. Before / after (same fixtures)

Before: `report` showed one pooled "First-party" block (clicks + impressions
summed across query/page rows), Top-queries rows indistinguishable from AI
exposure, empty grounding silently parametric, chunk indices shifted.

After: per-identity sections with per-kind slices; AI sections gated on
declared identity and badged UNVERIFIED; unknown retrieval as its own
denominator; citations resolved against position-preserved sources with
invalid references flagged unknown.

## 6. Remaining unverified integration behavior

- AI CSV layout vs a genuine authorized export (no sample available).
- Live Gemini grounded calls (key + budget required; `GHOSTPING_LIVE_GEMINI`
  gate in place, fixtures only in CI).
- Hosted CI on this branch (pushed; URL recorded in the PR).
- Windows/macOS packaging, Tauri, pwsh installer execution (unchanged).

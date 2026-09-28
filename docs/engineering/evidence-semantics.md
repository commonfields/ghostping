# Evidence semantics (kernel correctness)

How Ghostping preserves what upstream sources actually establish — and
refuses to upgrade uncertainty. Complements
`observation-integrity.md` (import/migration mechanics).

No Jev, scoring, judging, or recommendations exist anywhere in this
design. The pipeline stops at deterministic interpretation:

```text
provider/platform emitted fact
        ↓
Ghostping-preserved observation
        ↓
deterministic interpretation
        ↓
(probabilistic judgment — explicitly not built)
```

## 1. Dimensional identity

A first-party measurement's natural key is:

```text
project | report_identity | surface | reporting_period | all present source dimensions
```

`DimensionTuple { page?, country?, device?, date?, other? }` preserves every
dimension present in the row with no hierarchy. Therefore:

```text
page=A, country=US   vs   page=A, country=GB      → different observations
page=A, device=desktop vs page=A, device=mobile   → different observations
date=2026-09-01      vs   date=2026-09-02         → different observations
```

Measurement values (impressions, clicks) never participate in identity.
`url_digest` is populated whenever a page URL exists, regardless of which
other dimensions the export carries.

Views group rows only by exact dimension signature (`page × country` is a
different slice from `page × device`). No cross-breakdown totals exist in
code: slices report row counts and per-row values, never sums. An overall
figure appears only if a future source format explicitly establishes
additivity — none does today.

Unknown layouts: AI imports with no recognizable dimension
(page/country/device/date) are refused with a diagnostic, not guessed.
Generic imports preserve unrecognized columns verbatim in the tuple.

## 2. Zero / unavailable semantics

Every imported number keeps two layers:

```text
reported token (raw)  +  parsed value  +  semantics ∈ {reported, unavailable}
```

- missing/empty → `value: None`, `unavailable`. Never zero.
- `0` / `0%` → `value: 0`, `reported`, raw token preserved. This says
  "**0 reported by source**" and nothing stronger: the export format cannot
  distinguish an independently observed zero from a rendered unavailable.
- Reports render unavailable as `unknown` and reported-zero as
  `0 (reported by source)`. No view claims `confirmed zero`.
- Malformed numbers fail the import with a line number (fail-closed).

(Earlier docs stated empty CTR/position "stay None, not zero" — true — but
also implied explicit zeros were observed zeros. That stronger claim is
retracted: reported-zero is the honest ceiling.)

## 3. Gemini byte-offset semantics

Per the provider contract, `groundingSupports[].segment` carries
`partIndex`/`startIndex`/`endIndex`/`text` where offsets are **byte
offsets into the referenced part**. Ghostping preserves `ResponsePart`s
and validates `part[bytes[start..end]]` against `segment.text`:

- missing `partIndex` → part 0 (single-part shape);
- negative, reversed, out-of-range, or non-UTF-8-boundary offsets → invalid;
- slice ≠ segment text (when text supplied) → invalid;
- never panics on malformed offsets (`str::get` range indexing).

(Earlier code concatenated parts and counted characters — semantically
wrong. The current `GROUNDING_INTERP_VERSION = 2` labels byte-offset
judgments so future reprocessing can distinguish them. Raw responses are
never mutated.)

## 4. Citation resolution states

```text
SourceStatus:  Valid | MissingUri | InvalidIndex
SpanStatus:    Valid | InvalidText | InvalidOffsets | NoClaim
Attribution:   Verified | Partial | Unknown
```

`Verified` requires ALL of: chunk index exists, chunk has a supported URI,
part exists, offsets valid under byte semantics, slice matches supplied
segment text. A span citing several chunks where only some resolve is
`Partial` (valid sources listed, problems listed) — never silently fully
verified. Anything else is `Unknown`. A parse-time integrity warning never
coexists with a `Verified` attribution for the same span.

## 5. Raw-evidence immutability

No migration rewrites historical raw responses. New interpretation is
derived at read time (`resolved_citations()`) and labeled
(`interpretation_version`). Pre-semantics payloads (bare numbers,
`dimension_kind`/`dimension_value`) remain readable via tolerant readers.

## 6. Remaining unverified behavior

- Generative-AI CSV layout vs a genuine authorized export (no sample;
  importer stays UNVERIFIED).
- Live Gemini grounded calls (credential + budget gate; fixtures only).
- Whether Google's UI-rendered zeros ever reach CSV exports as `0`
  (exports are authoritative; UI is not consulted).
- Hosted CI on the delivery branch (URL in the PR).

# External Inference V1 — Notion controlled fixture

Engineering-validation fixture only. NOT customer validation. NOT a claim
about ChatGPT/Gemini/Claude consumer surfaces.

- Business: **Notion** (Notion Labs, Inc.) — real public SaaS, chosen 2026-10-01.
- Official source: `https://www.notion.so/pricing` (monthly billing, USD).
- Captured: **2026-10-01**. Re-verify against the live page before judging
  any future live run; if the page changed, freeze a new capture date.
- Live runs performed against this fixture so far: **0** (9Router
  credentials deferred; see `docs/engineering/external-inference-v1.md`).

## Frozen approved facts

| # | subject | predicate | valueText | valueType | source |
|---|---------|-----------|-----------|-----------|--------|
| F1 | notion | plus_monthly_price | $10 | CURRENCY | pricing page: Plus `$10per member / month` |
| F2 | notion | business_monthly_price | $20 | CURRENCY | pricing page: Business `$20per member / month` |
| F3 | notion | slack_integration_plus | supported via basic connections | TEXT | pricing page: Plus `Connect to some tools like Slack & Google Drive`, `Basic connections` |
| F4 | notion | offline_support | desktop and mobile apps can download pages for offline use | TEXT | pricing grid `Offline` row |
| F5 | notion | free_page_history | 7 days | TEXT | pricing grid `Page history`: Free `7 days` |
| F6 | notion | enterprise_audit_log | available | TEXT | Enterprise plan lists `Audit log` |
| F7 | notion | free_file_upload_limit | 5 MB per file | TEXT | pricing grid `File uploads`: Free `Up to 5 MB` |
| F8 | notion | business_sso | SAML single sign-on | TEXT | Business plan lists `SAML SSO` |

All facts: `validFrom = 2026-10-01T00:00:00Z`, `validUntil = null`,
`sourceKind = WEBSITE`.

## Frozen buyer questions (asked verbatim; never tuned after answers)

| # | question | probes | origin |
|---|----------|--------|--------|
| Q1 | How much does Notion Plus cost per member per month? | F1 | BUSINESS_OWNER |
| Q2 | How much does Notion Business cost per member per month? | F2 | BUSINESS_OWNER |
| Q3 | Does Notion connect to Slack on the Plus plan? | F3 | SALES |
| Q4 | Does the Notion desktop app work offline? | F4 | SUPPORT |
| Q5 | How many days of page history does the Notion Free plan include? | F5 | CUSTOMER_INTERVIEW |
| Q6 | Does Notion Enterprise offer an audit log? | F6 | SALES |
| Q7 | What is the per-file upload limit on the Notion Free plan? | F7 | SUPPORT |
| Q8 | Does Notion Business offer SAML single sign-on? | F8 | SALES |

Questions were frozen BEFORE the first model run. No live run has occurred
yet; when runs happen, answers must not be used to rephrase questions to
manufacture discrepancies.

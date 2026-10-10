# One agency, three client records

OpenRecord records what one AI surface said about three approved business facts,
then preserves a human review and a later comparable check. The agency performs
its own source changes. OpenRecord does not apply corrections or prove causality.

## Deployment prerequisites

- Node 24, pnpm 10.12.1 and PostgreSQL 16.
- Run the repository migrations, including `0021`, `0022` and `0023`, before
  starting the API and worker. Replay is supported.
- Start API, worker and web as separate processes. The built API and worker
  use `node --import tsx dist/server.js` and `node --import tsx dist/runner.js`
  from their application directories.
- Set the same `GEMINI_MODEL` on API and worker. The default is
  `gemini-2.5-flash`. Set `GEMINI_API_KEY` securely on the worker.
  The adapter uses Google's supported [generateContent API](https://ai.google.dev/api/generate-content)
  and preserves returned grounding metadata and search suggestions. Requested
  retrieval alone never establishes observed retrieval.
- Use `RECORD_PROVIDER=gemini` (the default) for live delivery. Leave
  `RECORD_ALLOW_FIXTURE` unset. Never use mock evidence as client proof.
- Route `/api` to the API and `/open/*` to the web application. Serve over
  HTTPS, with `APP_BASE_URL` matching the deployed origin. Confirm the SPA
  fallback supports direct navigation to a share URL.
- Perform a controlled, explicitly authorized DOGFOOD check with real
  credentials before accepting a paid delivery. Confirm observed retrieval,
  citations, model identity, raw evidence and public access/revocation.

The local fixture checks do not prove live credentials, current model
availability, grounding-widget layout, DNS or production deployment behavior.

## Manual operator workflow

1. **Agency/account:** use the existing account and sign in. For a new agency,
   the owner can use the existing `/signup` account-creation screen; each Account
   represents one agency. The existing signup API also accepts `accountName`.
   This milestone adds no onboarding service or agency CRM.
2. **Client:** open **Clients**, choose **New client**, enter the real client
   name and public website, and choose **Client engagement**. Choose **Dogfood**
   only for a site you control or are explicitly authorized to test.
3. **Facts/questions:** fill the three fact slots. Each needs a fact label,
   approved value, type, public source URL and one buyer-style question.
   Choose **Save fact**. These versions are drafts until approved.
4. **Approve:** confirm the source and value with the client, then choose
   **Approve fact** while signed in as the actual reviewer. The session user
   and server timestamp provide attribution. Do not approve on a client's
   behalf without their factual confirmation.
5. **First check:** choose **Run first check**. Each approved fact gets a
   separate persisted CheckRun. Watch queued/running/final status. A provider
   failure stays visible; it does not switch to another model.
6. **Review:** read each exact answer and citations. Check whether retrieval
   actually occurred. Choose **Matches**, **Contradicts** or **Unknown**.
   Internal review notes remain private. A later review correction appends
   a new judgment; it preserves the earlier one.
7. **Share:** once reviewed and authorized for publication, choose
   **Create share link**, then **Copy link**. One stable `/open/<opaque-id>`
   URL serves the reviewed record. Anyone holding the link can read it.
   Unreviewed answers, internal notes and internal IDs are excluded.
8. **Agency action:** record what the agency changed, its date and an optional
   source link. This note is client-visible. Keep confidential details out.
9. **Weekly check:** choose **Run weekly re-check** manually. Keep facts,
   questions and configured surface unchanged for comparability.
10. **Review again:** inspect and judge the new answers. The record derives
    an outcome from the preserved baseline and follow-up evidence.
11. **Revoke:** choose **Revoke link**. The old URL returns a non-disclosing
    404. Creating a share afterwards produces a new URL; the old one never
    reactivates. A page someone already downloaded cannot be recalled.

Repeat client setup for the other two clients. Normal operation needs no SQL
or database edits. Pricing, invoices, publication permission and payment stay
outside the application.

## Outcomes and failures

- **Observed correction:** reviewed CONTRADICTS to MATCHES, with comparable,
  complete, retrieval-backed, non-synthetic checks.
- **No observed change:** reviewed CONTRADICTS to CONTRADICTS under the same
  eligibility rules.
- **Indeterminate:** unknown judgment, missing retrieval, model/configuration
  change, changed fact/question, partial execution, failed check or synthetic
  evidence. An initially matching fact has no contradiction against which
  to verify a correction; its matching answers remain visible with that reason.

Never rerun repeatedly to select a better-looking answer. An explicit new run
is required after failure. An abandoned RUNNING check expires after the
15-minute lease and becomes FAILED / WORKER_LOST; recovery creates no provider
request. Provider retries during a live check remain bounded to four attempts.

Editing a slot creates a version requiring fresh approval. Older checks retain
their exact question and fact; their judgment is not assigned to new wording.
Validity timestamps are preserved on repeated saves. Advanced validity dates
can be supplied through the authenticated slot API; the UI does not currently
provide date editors. Expired/future approved facts block a new run until
their current versions are saved and approved.

The public record prominently states:

> This shows what OpenRecord observed before and after the change. It does not
> prove that the edit caused the model's new answer.

## Fixture verification

Use only an explicitly disposable loopback database. After migrations and
`pnpm build`, run `HOSTED_SMOKE_ALLOWED=1 python3 scripts/agency-record-runtime-smoke.py`
with `DATABASE_URL` pointing at that database. It provisions labeled TEST data
through the real API, drives the built worker with mock responses, reviews the
answers as a TEST actor, checks three stable shares and revocation, and requires
synthetic follow-ups to remain INDETERMINATE. It performs no live provider call.

Grounded correction/no-change, missing retrieval, ambiguity and partial failure
are separately covered by `apps/worker/src/record.acceptance.integration.test.ts`
using deterministic local provider fixtures. These are engineering evidence,
not customer validation.

## Commercial handoff

Supply a real agency, three authorized clients, three approved facts per client,
provider credentials and permission to publish. Deliver four weekly checks and
the record links, then invoice outside the application. Record actual payment
and renewal evidence. Do not describe fixtures or dogfood as paid validation.
Keep expansion frozen until five agencies genuinely pay.

Legacy domain redirects are an external infrastructure task if the owner still
controls Ghostping domains. Repository branding cleanup does not prove that
DNS or redirects were configured.

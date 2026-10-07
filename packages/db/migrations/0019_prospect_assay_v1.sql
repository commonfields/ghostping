-- 0019_prospect_assay_v1.sql — minimal prospect-assay tooling (Phase 2).
--
-- Read-only assay, no mutation expansion. Proposed facts stay
-- PUBLIC_SOURCE_UNAPPROVED until a human reviews them; only CONFIRMED
-- facts participate in contradiction scoring. Repeated sampling groups N
-- check runs (one observation each) so probabilistic answers are stored
-- independently and never silently collapsed into success.

-- Retrieval-aware vocabulary: NONE / WEB_SEARCH / PROVIDER_GROUNDING /
-- MANUAL_CAPTURE alongside the legacy unknown|grounded|parametric values
-- already stored on existing rows.
ALTER TABLE observations DROP CONSTRAINT IF EXISTS observations_retrieval_mode_check;
ALTER TABLE observations ADD CONSTRAINT observations_retrieval_mode_check CHECK (
  retrieval_mode IN ('unknown','grounded','parametric','NONE','WEB_SEARCH','PROVIDER_GROUNDING','MANUAL_CAPTURE')
);

-- Provenance the program requires per external observation. All nullable:
-- engines that cannot report a field store NULL rather than inventing it.
ALTER TABLE observations
  ADD COLUMN IF NOT EXISTS model_version TEXT,
  ADD COLUMN IF NOT EXISTS retrieval_tool TEXT,
  ADD COLUMN IF NOT EXISTS request_parameters JSONB;

-- Proposed prospect facts. PUBLIC_SOURCE_UNAPPROVED until reviewed.
-- normalized holds the objective semantics, e.g. MoneyFact
-- {amount_minor, currency, billing_period, unit, qualifier}.
CREATE TABLE IF NOT EXISTS assay_proposed_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  fact_type TEXT NOT NULL CHECK (fact_type IN ('PRICE','PLAN_AVAILABILITY','BOOLEAN_CAPABILITY')),
  subject TEXT NOT NULL,
  normalized JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','CONFIRMED','INCORRECT_EXTRACTION','AMBIGUOUS')),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_reason TEXT,
  promoted_fact_id UUID REFERENCES authoritative_facts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'PROPOSED') = (reviewed_by IS NULL AND reviewed_at IS NULL)),
  CHECK (status = 'PROPOSED' OR reviewed_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_assay_proposed_facts_business ON assay_proposed_facts(business_id, status);

-- One repeated-sampling run: N check runs of the same question/engine.
-- PARTIALLY_SUCCEEDED when some samples failed (never silent success).
CREATE TABLE IF NOT EXISTS assay_sample_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES buyer_questions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  requested_model TEXT,
  retrieval_mode TEXT NOT NULL DEFAULT 'NONE' CHECK (retrieval_mode IN ('NONE','WEB_SEARCH','PROVIDER_GROUNDING','MANUAL_CAPTURE')),
  n INT NOT NULL CHECK (n > 0),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','PARTIALLY_SUCCEEDED','SUCCEEDED','FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assay_sample_groups_business ON assay_sample_groups(business_id);

ALTER TABLE check_runs
  ADD COLUMN IF NOT EXISTS assay_sample_group_id UUID REFERENCES assay_sample_groups(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS sample_number INT CHECK (sample_number IS NULL OR sample_number > 0);
CREATE INDEX IF NOT EXISTS idx_check_runs_sample_group ON check_runs(assay_sample_group_id) WHERE assay_sample_group_id IS NOT NULL;

-- Candidate findings: claim-vs-confirmed-fact comparison over one sample
-- group. verdict follows the N=5 thresholds (1/5 ANECDOTAL, 2/5
-- OBSERVED_INTERMITTENT, 3-5/5 CONFIRMED); UNCLEAR never contradicts.
CREATE TABLE IF NOT EXISTS assay_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sample_group_id UUID NOT NULL REFERENCES assay_sample_groups(id) ON DELETE CASCADE,
  proposed_fact_id UUID NOT NULL REFERENCES assay_proposed_facts(id) ON DELETE CASCADE,
  sample_count INT NOT NULL CHECK (sample_count > 0),
  contradict_count INT NOT NULL CHECK (contradict_count >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('ANECDOTAL','OBSERVED_INTERMITTENT','CONFIRMED')),
  supporting_spans JSONB NOT NULL DEFAULT '[]',
  likely_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (contradict_count <= sample_count)
);
CREATE INDEX IF NOT EXISTS idx_assay_findings_business ON assay_findings(business_id);

-- Human review of candidate findings. The agent builds the queue; only a
-- human records a review. One review per finding (append replaces).
CREATE TABLE IF NOT EXISTS assay_finding_reviews (
  finding_id UUID PRIMARY KEY REFERENCES assay_findings(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  reviewed_by TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision TEXT NOT NULL CHECK (decision IN ('REVIEWED_CORRECT','REVIEWED_FALSE_POSITIVE','REVIEWED_NOT_MEANINGFUL')),
  review_reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

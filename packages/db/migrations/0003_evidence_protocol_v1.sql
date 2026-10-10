-- Evidence Protocol V1: additive persistence for measurement provenance,
-- append-only interventions, and re-observation linkage.
--
-- Re-runnable by design (the runner applies every file on each migrate):
-- IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS throughout.
-- Existing Hosted V1 rows stay valid: new columns are nullable or defaulted,
-- and NULL protocol metadata means "not recorded" (exported as UNKNOWN).
--
-- Stored here: evidence and events. NOT stored: match classification,
-- observed change, outcome, "corrected" flags, or causal claims. Those are
-- derived by @openrecord/protocol at export time from these rows.

-- Raw evidence: exact wire bytes when the worker supplies them. Rows are
-- digest-deduplicated, so received_at is the first receipt of those bytes.
ALTER TABLE raw_evidence ADD COLUMN IF NOT EXISTS raw_bytes_hex TEXT;
ALTER TABLE raw_evidence ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE raw_evidence ADD COLUMN IF NOT EXISTS provider_metadata JSONB;

-- Observations: protocol surface identity and measurement context.
ALTER TABLE observations ADD COLUMN IF NOT EXISTS surface_identity JSONB;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS measurement_context JSONB;
ALTER TABLE observations ADD COLUMN IF NOT EXISTS synthetic BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'observations_mock_is_synthetic') THEN
    -- A MOCK surface can never be stored as production evidence.
    ALTER TABLE observations ADD CONSTRAINT observations_mock_is_synthetic
      CHECK (surface_identity IS NULL OR surface_identity->>'kind' <> 'MOCK' OR synthetic);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION prevent_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Interventions (action events). Corrections append a superseding row.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interventions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'SOURCE_UPDATED','SOURCE_PUBLISHED','THIRD_PARTY_CORRECTION_REQUESTED',
    'KNOWLEDGE_BASE_UPDATED','STRUCTURED_DATA_UPDATED','OTHER'
  )),
  target TEXT NOT NULL,
  performed_at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('HUMAN','AGENT','SYSTEM','UNKNOWN')),
  -- NULL = identity not proven (exported as UNKNOWN). Never fabricated.
  actor_id TEXT,
  notes TEXT,
  -- NULL = OpenRecord holds no content digest (exported as UNKNOWN).
  evidence_before_digest TEXT CHECK (evidence_before_digest IS NULL OR evidence_before_digest ~ '^[a-f0-9]{64}$'),
  evidence_after_digest TEXT CHECK (evidence_after_digest IS NULL OR evidence_after_digest ~ '^[a-f0-9]{64}$'),
  supersedes_id UUID REFERENCES interventions(id),
  correction_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((supersedes_id IS NULL) = (correction_reason IS NULL)),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
CREATE INDEX IF NOT EXISTS idx_interventions_business ON interventions(business_id, performed_at);
-- Linear correction chains: one correction per intervention; concurrent
-- competing corrections serialize on this index and exactly one wins.
CREATE UNIQUE INDEX IF NOT EXISTS uq_interventions_supersedes ON interventions(supersedes_id) WHERE supersedes_id IS NOT NULL;

-- Issues are a derived view whose stable identity is the candidate claim id.
CREATE TABLE IF NOT EXISTS intervention_issues (
  intervention_id UUID NOT NULL REFERENCES interventions(id),
  issue_id UUID NOT NULL REFERENCES candidate_claims(id),
  PRIMARY KEY (intervention_id, issue_id)
);
CREATE INDEX IF NOT EXISTS idx_intervention_issues_issue ON intervention_issues(issue_id);

CREATE OR REPLACE FUNCTION check_intervention_tenancy() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'interventions' THEN
    IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM interventions i WHERE i.id = NEW.supersedes_id AND i.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'intervention % supersedes an intervention of another business', NEW.id;
    END IF;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM interventions i JOIN candidate_claims c ON c.business_id = i.business_id
      WHERE i.id = NEW.intervention_id AND c.id = NEW.issue_id
    ) THEN
      RAISE EXCEPTION 'intervention % and issue % belong to different businesses', NEW.intervention_id, NEW.issue_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_interventions_tenancy ON interventions;
CREATE TRIGGER trg_interventions_tenancy BEFORE INSERT ON interventions
FOR EACH ROW EXECUTE FUNCTION check_intervention_tenancy();
DROP TRIGGER IF EXISTS trg_intervention_issues_tenancy ON intervention_issues;
CREATE TRIGGER trg_intervention_issues_tenancy BEFORE INSERT ON intervention_issues
FOR EACH ROW EXECUTE FUNCTION check_intervention_tenancy();

DROP TRIGGER IF EXISTS trg_interventions_no_update ON interventions;
CREATE TRIGGER trg_interventions_no_update BEFORE UPDATE OR DELETE ON interventions
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_intervention_issues_no_update ON intervention_issues;
CREATE TRIGGER trg_intervention_issues_no_update BEFORE UPDATE OR DELETE ON intervention_issues
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_interventions_no_truncate ON interventions;
CREATE TRIGGER trg_interventions_no_truncate BEFORE TRUNCATE ON interventions
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

-- ---------------------------------------------------------------------------
-- Re-observation linkage. Pure lineage: no signature, match, or outcome.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reobservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  original_observation_id UUID NOT NULL REFERENCES observations(id),
  issue_id UUID NOT NULL REFERENCES candidate_claims(id),
  intervention_id UUID REFERENCES interventions(id),
  observation_id UUID NOT NULL REFERENCES observations(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (issue_id, observation_id),
  CHECK (original_observation_id <> observation_id)
);
CREATE INDEX IF NOT EXISTS idx_reobservations_issue ON reobservations(issue_id, created_at);

CREATE OR REPLACE FUNCTION check_reobservation_lineage() RETURNS trigger AS $$
DECLARE
  before_at TIMESTAMPTZ;
  after_at TIMESTAMPTZ;
BEGIN
  -- The issue's claim must belong to this business and the original observation.
  IF NOT EXISTS (
    SELECT 1 FROM candidate_claims c
    WHERE c.id = NEW.issue_id AND c.business_id = NEW.business_id AND c.observation_id = NEW.original_observation_id
  ) THEN
    RAISE EXCEPTION 're-observation issue % does not belong to original observation % of business %', NEW.issue_id, NEW.original_observation_id, NEW.business_id;
  END IF;
  SELECT collected_at INTO before_at FROM observations WHERE id = NEW.original_observation_id AND business_id = NEW.business_id;
  SELECT collected_at INTO after_at FROM observations WHERE id = NEW.observation_id AND business_id = NEW.business_id;
  IF before_at IS NULL OR after_at IS NULL THEN
    RAISE EXCEPTION 're-observation observations must belong to business %', NEW.business_id;
  END IF;
  IF after_at <= before_at THEN
    RAISE EXCEPTION 're-observation % must be collected after the original observation', NEW.observation_id;
  END IF;
  IF NEW.intervention_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM intervention_issues ii JOIN interventions i ON i.id = ii.intervention_id
    WHERE ii.intervention_id = NEW.intervention_id AND ii.issue_id = NEW.issue_id AND i.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'intervention % is not linked to issue %', NEW.intervention_id, NEW.issue_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reobservations_lineage ON reobservations;
CREATE TRIGGER trg_reobservations_lineage BEFORE INSERT ON reobservations
FOR EACH ROW EXECUTE FUNCTION check_reobservation_lineage();
DROP TRIGGER IF EXISTS trg_reobservations_no_update ON reobservations;
CREATE TRIGGER trg_reobservations_no_update BEFORE UPDATE OR DELETE ON reobservations
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

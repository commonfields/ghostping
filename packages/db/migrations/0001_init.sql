-- Hosted V1 initial schema. PostgreSQL is the sole hosted store.
-- Local CLI mode keeps using SQLite evidence.db; hosted never touches it.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email CITEXT UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- CITEXT may be unavailable; fall back gracefully handled in migrate.ts.
-- The canonical email column is created as TEXT UNIQUE when CITEXT missing.

CREATE TABLE IF NOT EXISTS account_users (
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_businesses_account ON businesses(account_id);

CREATE TABLE IF NOT EXISTS authoritative_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value_text TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('TEXT','NUMBER','CURRENCY','BOOLEAN','DATE','URL','ENUM')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED','RETIRED')),
  version INT NOT NULL DEFAULT 1,
  supersedes_id UUID REFERENCES authoritative_facts(id),
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ,
  source_kind TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source_kind IN ('MANUAL','WEBSITE','PRODUCT_CATALOG','POLICY_DOCUMENT','OTHER')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (valid_until IS NULL OR valid_from < valid_until)
);
CREATE INDEX IF NOT EXISTS idx_facts_business ON authoritative_facts(business_id, subject, predicate, status);

CREATE TABLE IF NOT EXISTS buyer_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label TEXT,
  prompt TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'OTHER' CHECK (origin IN ('BUSINESS_OWNER','SALES','SUPPORT','CUSTOMER_INTERVIEW','SEARCH_DATA','OPERATOR_CONSTRUCTED','OTHER')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_questions_business ON buyer_questions(business_id);

CREATE TABLE IF NOT EXISTS check_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES buyer_questions(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'mock',
  requested_model TEXT,
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failure_class TEXT,
  failure_detail_safe TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_check_runs_status ON check_runs(status, queued_at);

CREATE TABLE IF NOT EXISTS raw_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  digest TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL DEFAULT 'application/json',
  content_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  check_run_id UUID NOT NULL UNIQUE REFERENCES check_runs(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  requested_model TEXT,
  observed_model TEXT,
  collected_at TIMESTAMPTZ NOT NULL,
  answer_text TEXT NOT NULL,
  retrieval_mode TEXT NOT NULL DEFAULT 'unknown' CHECK (retrieval_mode IN ('unknown','grounded','parametric')),
  raw_evidence_id UUID NOT NULL REFERENCES raw_evidence(id),
  raw_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- No UPDATE/DELETE grants are managed at app level: the API exposes no
-- update/delete for observations; immutability is enforced by API surface
-- plus a defensive trigger below.
CREATE OR REPLACE FUNCTION prevent_observation_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'observations are append-only';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_observations_no_update ON observations;
CREATE TRIGGER trg_observations_no_update BEFORE UPDATE OR DELETE ON observations
FOR EACH ROW EXECUTE FUNCTION prevent_observation_mutation();
DROP TRIGGER IF EXISTS trg_raw_evidence_no_update ON raw_evidence;
CREATE TRIGGER trg_raw_evidence_no_update BEFORE UPDATE OR DELETE ON raw_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_observation_mutation();

CREATE TABLE IF NOT EXISTS observation_citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id UUID NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  uri TEXT,
  title TEXT,
  position INT,
  attributed BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_citations_obs ON observation_citations(observation_id);

CREATE TABLE IF NOT EXISTS candidate_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'MANUAL_TRANSCRIPTION' CHECK (origin IN ('MANUAL_TRANSCRIPTION','MANUAL_EXACT_SPAN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_claims_obs ON candidate_claims(observation_id);
CREATE INDEX IF NOT EXISTS idx_claims_business ON candidate_claims(business_id);

CREATE TABLE IF NOT EXISTS human_judgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  claim_id UUID NOT NULL REFERENCES candidate_claims(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL CHECK (verdict IN ('SUPPORTED','CONTRADICTED','PARTIAL','INSUFFICIENT_EVIDENCE')),
  notes TEXT,
  supersedes_id UUID REFERENCES human_judgments(id),
  superseded BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_judgments_claim ON human_judgments(claim_id, created_at);

CREATE TABLE IF NOT EXISTS human_judgment_facts (
  judgment_id UUID NOT NULL REFERENCES human_judgments(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES authoritative_facts(id),
  PRIMARY KEY (judgment_id, fact_id)
);

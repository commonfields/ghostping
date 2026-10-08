-- SEARCH_OPERATOR_V1: durable site inspection + findings + remediation loop.
-- Additive, re-runnable (IF NOT EXISTS throughout).
--
-- Tenancy: every row carries business_id; child rows must belong to the same
-- business as their parents (triggers). Orchestration rows (targets, runs,
-- findings, proposals, mutations, verifications) are mutable job state with
-- guarded transitions; page observations, finding events, and operator
-- events are append-only evidence (no UPDATE/DELETE triggers).
--
-- Findings preserve history: status lives on site_findings, every transition
-- appends to site_finding_events. Observations, diagnosis, remediation, and
-- verification are never collapsed into one mutable row without evidence.

-- ---------------------------------------------------------------------------
-- Site targets: a business-registered website root + optional repo binding.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  root_url TEXT NOT NULL,
  canonical_origin TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '/',
  enabled BOOLEAN NOT NULL DEFAULT true,
  adapter_kind TEXT NOT NULL DEFAULT 'LOCAL_FILE'
    CHECK (adapter_kind IN ('LOCAL_FILE','GIT','GITHUB')),
  repo_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_targets_business_origin_prefix
  ON site_targets(business_id, canonical_origin, path_prefix);
CREATE INDEX IF NOT EXISTS idx_site_targets_business
  ON site_targets(business_id, created_at);

-- ---------------------------------------------------------------------------
-- Inspection runs: QUEUED -> RUNNING -> SUCCEEDED | PARTIALLY_SUCCEEDED | FAILED
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_inspection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_target_id UUID NOT NULL REFERENCES site_targets(id) ON DELETE CASCADE,
  inspector_version TEXT NOT NULL DEFAULT 'site-inspector/1',
  policy_version TEXT NOT NULL DEFAULT 'site-operator-policy/1',
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','PARTIALLY_SUCCEEDED','FAILED')),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  failure_class TEXT,
  failure_detail_safe TEXT,
  urls_inspected INT NOT NULL DEFAULT 0,
  urls_failed INT NOT NULL DEFAULT 0,
  findings_produced INT NOT NULL DEFAULT 0,
  bytes_downloaded BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_runs_target
  ON site_inspection_runs(site_target_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_runs_business
  ON site_inspection_runs(business_id, queued_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_runs_one_active_per_target
  ON site_inspection_runs(site_target_id)
  WHERE state IN ('QUEUED','RUNNING');

-- ---------------------------------------------------------------------------
-- Page observations: append-only raw evidence per inspected URL.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_page_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES site_inspection_runs(id) ON DELETE CASCADE,
  site_target_id UUID NOT NULL REFERENCES site_targets(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  discovered_via TEXT NOT NULL DEFAULT 'ROOT'
    CHECK (discovered_via IN ('ROOT','ROBOTS_SITEMAP','DEFAULT_SITEMAP','SITEMAP','LINK')),
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  http_status INT,
  content_type TEXT,
  redirect_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  body_digest TEXT,
  body_bytes BIGINT NOT NULL DEFAULT 0,
  indexability TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (indexability IN ('INDEXABLE','BLOCKED_BY_META','BLOCKED_BY_HEADER','BLOCKED_BY_ROBOTS','REDIRECTED','NOT_FOUND','SERVER_ERROR','CANONICALIZED_ELSEWHERE','RENDERING_FAILURE','UNKNOWN')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  collection_state TEXT NOT NULL DEFAULT 'FETCHED'
    CHECK (collection_state IN ('FETCHED','NOT_MODIFIED','FAILED')),
  failure TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_page_obs_run
  ON site_page_observations(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_page_obs_canonical
  ON site_page_observations(business_id, site_target_id, canonical_url, completed_at DESC);

-- ---------------------------------------------------------------------------
-- Findings: durable website/search problems with evidence binding.
-- Identity: (business_id, identity_key) unique; identity_key =
-- sha256(business + normalized_url + finding_kind + evidence_digest).
-- Repeated identical inspections resolve the same key (no duplicates).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  site_target_id UUID NOT NULL REFERENCES site_targets(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES site_inspection_runs(id) ON DELETE CASCADE,
  page_observation_id UUID REFERENCES site_page_observations(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  finding_kind TEXT NOT NULL
    CHECK (finding_kind IN ('BLOCKED_BY_META','BLOCKED_BY_HEADER','BLOCKED_BY_ROBOTS','NOT_FOUND','SERVER_ERROR','REDIRECT_LOOP','REDIRECT_CHAIN_LONG','BROKEN_CANONICAL','CANONICALIZED_ELSEWHERE','MISSING_TITLE','MISSING_DESCRIPTION','MISSING_H1','BROKEN_INTERNAL_LINK','POSSIBLE_ORPHAN','INVALID_STRUCTURED_DATA','MISSING_ALT','RENDER_DISCREPANCY','SITEMAP_INVALID','SITEMAP_MISSING','ROBOTS_BLOCKS_IMPORTANT')),
  severity TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (severity IN ('CRITICAL','HIGH','MEDIUM','LOW')),
  category TEXT NOT NULL DEFAULT 'INFORMATIONAL'
    CHECK (category IN ('CRAWL_INDEX_RISK','USABILITY_ACCESSIBILITY','SEARCH_PRESENTATION','CONTENT_OPPORTUNITY','INFORMATIONAL')),
  status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN','AWAITING_APPROVAL','APPROVED','FIX_IN_PROGRESS','FIX_APPLIED','VERIFICATION_PENDING','VERIFIED_FIXED','VERIFIED_NOT_FIXED','DISMISSED','UNKNOWN')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  diagnosis TEXT NOT NULL DEFAULT '',
  recommended_action TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'MEDIUM'
    CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  source_digest TEXT,
  evidence_digest TEXT,
  identity_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, identity_key)
);
CREATE INDEX IF NOT EXISTS idx_site_findings_business_status
  ON site_findings(business_id, status, severity);
CREATE INDEX IF NOT EXISTS idx_site_findings_target
  ON site_findings(site_target_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_findings_run
  ON site_findings(run_id, finding_kind);

-- ---------------------------------------------------------------------------
-- Finding events: append-only status/evidence history (never rewritten).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_finding_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL REFERENCES site_findings(id) ON DELETE CASCADE,
  run_id UUID REFERENCES site_inspection_runs(id) ON DELETE SET NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'SYSTEM',
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_finding_events_finding
  ON site_finding_events(finding_id, created_at);

-- ---------------------------------------------------------------------------
-- Fix proposals: smallest safe correction per finding, with approval gate.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_fix_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL REFERENCES site_findings(id) ON DELETE CASCADE,
  fix_kind TEXT NOT NULL
    CHECK (fix_kind IN ('REMOVE_NOINDEX_META','FIX_CANONICAL','REPAIR_SITEMAP','FIX_INTERNAL_LINK','ADD_TITLE','ADD_DESCRIPTION','ADD_ALT','FIX_STRUCTURED_DATA','MANUAL_ONLY')),
  target TEXT NOT NULL,
  file_path TEXT,
  before_text TEXT,
  after_text TEXT,
  patch TEXT,
  rationale TEXT NOT NULL DEFAULT '',
  risk TEXT NOT NULL DEFAULT '',
  classification TEXT NOT NULL DEFAULT 'MANUAL_ONLY'
    CHECK (classification IN ('SAFE_AUTOMATIC','APPROVAL_REQUIRED','MANUAL_ONLY')),
  requires_approval BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED','APPROVED','REJECTED','SUPERSEDED')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_fix_proposals_finding
  ON site_fix_proposals(finding_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_site_fix_proposals_business
  ON site_fix_proposals(business_id, status);

-- ---------------------------------------------------------------------------
-- Mutations: branch/commit/PR identity for an approved fix. V1 never merges
-- automatically; MERGED is observed, never performed by OpenRecord.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_mutations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  fix_proposal_id UUID NOT NULL REFERENCES site_fix_proposals(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL REFERENCES site_findings(id) ON DELETE CASCADE,
  adapter_kind TEXT NOT NULL DEFAULT 'LOCAL_FILE'
    CHECK (adapter_kind IN ('LOCAL_FILE','GIT','GITHUB')),
  branch TEXT,
  commit_sha TEXT,
  pr_number INT,
  pr_url TEXT,
  state TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (state IN ('CREATED','BRANCH_CREATED','PR_OPEN','MERGED','FAILED')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_mutations_finding
  ON site_mutations(finding_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Verifications: live re-observation outcomes. A mutation is complete only
-- after OpenRecord inspects the live target again.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  finding_id UUID NOT NULL REFERENCES site_findings(id) ON DELETE CASCADE,
  mutation_id UUID REFERENCES site_mutations(id) ON DELETE SET NULL,
  run_id UUID REFERENCES site_inspection_runs(id) ON DELETE SET NULL,
  before_digest TEXT,
  after_digest TEXT,
  result TEXT NOT NULL DEFAULT 'VERIFICATION_PENDING'
    CHECK (result IN ('VERIFICATION_PENDING','VERIFIED_FIXED','VERIFIED_NOT_FIXED')),
  detail TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_verifications_finding
  ON site_verifications(finding_id, checked_at DESC);

-- ---------------------------------------------------------------------------
-- Operator events: structured operational log (no secrets, no bodies).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_operator_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  run_id UUID REFERENCES site_inspection_runs(id) ON DELETE SET NULL,
  finding_id UUID REFERENCES site_findings(id) ON DELETE SET NULL,
  kind TEXT NOT NULL
    CHECK (kind IN ('RUN_QUEUED','RUN_STARTED','URL_INSPECTED','FINDING_CREATED','FIX_PROPOSED','APPROVAL_GRANTED','MUTATION_STARTED','MUTATION_COMPLETED','VERIFICATION_STARTED','VERIFICATION_COMPLETED','RUN_FAILED','RUN_SUCCEEDED')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_site_operator_events_run
  ON site_operator_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_operator_events_business
  ON site_operator_events(business_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Search Console properties: integration boundary (contract first).
-- Live rows require OAuth; fixtures are labeled and never presented as live.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS site_gsc_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_uri TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google-search-console',
  status TEXT NOT NULL DEFAULT 'BLOCKED_MISSING_CREDENTIALS'
    CHECK (status IN ('CONNECTED','BLOCKED_MISSING_CREDENTIALS','ERROR')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, property_uri)
);
CREATE INDEX IF NOT EXISTS idx_site_gsc_business
  ON site_gsc_properties(business_id, created_at);

-- ---------------------------------------------------------------------------
-- Tenancy guards: children must share their parents' business.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_site_operator_tenancy() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'site_targets' THEN
    IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = NEW.business_id) THEN
      RAISE EXCEPTION 'site target % has no business', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_inspection_runs' THEN
    IF NOT EXISTS (SELECT 1 FROM site_targets s WHERE s.id = NEW.site_target_id AND s.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'site run % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_page_observations' THEN
    IF NOT EXISTS (
      SELECT 1 FROM site_inspection_runs r JOIN site_targets s ON s.id = r.site_target_id
      WHERE r.id = NEW.run_id AND r.business_id = NEW.business_id
        AND s.id = NEW.site_target_id AND s.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'site page observation % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_findings' THEN
    IF NOT EXISTS (
      SELECT 1 FROM site_inspection_runs r JOIN site_targets s ON s.id = r.site_target_id
      WHERE r.id = NEW.run_id AND r.business_id = NEW.business_id
        AND s.id = NEW.site_target_id AND s.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'site finding % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_finding_events' THEN
    IF NOT EXISTS (SELECT 1 FROM site_findings f WHERE f.id = NEW.finding_id AND f.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'site finding event % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_fix_proposals' THEN
    IF NOT EXISTS (SELECT 1 FROM site_findings f WHERE f.id = NEW.finding_id AND f.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'site fix proposal % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_mutations' THEN
    IF NOT EXISTS (
      SELECT 1 FROM site_fix_proposals p JOIN site_findings f ON f.id = p.finding_id
      WHERE p.id = NEW.fix_proposal_id AND f.id = NEW.finding_id AND f.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'site mutation % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_verifications' THEN
    IF NOT EXISTS (SELECT 1 FROM site_findings f WHERE f.id = NEW.finding_id AND f.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'site verification % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'site_operator_events' THEN
    IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = NEW.business_id) THEN
      RAISE EXCEPTION 'site operator event has no business';
    END IF;
  ELSIF TG_TABLE_NAME = 'site_gsc_properties' THEN
    IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = NEW.business_id) THEN
      RAISE EXCEPTION 'site gsc property % has no business', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_site_targets_tenancy ON site_targets;
CREATE TRIGGER trg_site_targets_tenancy BEFORE INSERT ON site_targets
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_runs_tenancy ON site_inspection_runs;
CREATE TRIGGER trg_site_runs_tenancy BEFORE INSERT ON site_inspection_runs
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_page_obs_tenancy ON site_page_observations;
CREATE TRIGGER trg_site_page_obs_tenancy BEFORE INSERT ON site_page_observations
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_findings_tenancy ON site_findings;
CREATE TRIGGER trg_site_findings_tenancy BEFORE INSERT ON site_findings
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_finding_events_tenancy ON site_finding_events;
CREATE TRIGGER trg_site_finding_events_tenancy BEFORE INSERT ON site_finding_events
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_fix_proposals_tenancy ON site_fix_proposals;
CREATE TRIGGER trg_site_fix_proposals_tenancy BEFORE INSERT ON site_fix_proposals
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_mutations_tenancy ON site_mutations;
CREATE TRIGGER trg_site_mutations_tenancy BEFORE INSERT ON site_mutations
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_verifications_tenancy ON site_verifications;
CREATE TRIGGER trg_site_verifications_tenancy BEFORE INSERT ON site_verifications
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_operator_events_tenancy ON site_operator_events;
CREATE TRIGGER trg_site_operator_events_tenancy BEFORE INSERT ON site_operator_events
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();
DROP TRIGGER IF EXISTS trg_site_gsc_tenancy ON site_gsc_properties;
CREATE TRIGGER trg_site_gsc_tenancy BEFORE INSERT ON site_gsc_properties
FOR EACH ROW EXECUTE FUNCTION check_site_operator_tenancy();

-- Append-only evidence: observations, finding events, operator events.
DROP TRIGGER IF EXISTS trg_site_page_obs_no_update ON site_page_observations;
CREATE TRIGGER trg_site_page_obs_no_update BEFORE UPDATE OR DELETE ON site_page_observations
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_site_finding_events_no_update ON site_finding_events;
CREATE TRIGGER trg_site_finding_events_no_update BEFORE UPDATE OR DELETE ON site_finding_events
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_site_operator_events_no_update ON site_operator_events;
CREATE TRIGGER trg_site_operator_events_no_update BEFORE UPDATE OR DELETE ON site_operator_events
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

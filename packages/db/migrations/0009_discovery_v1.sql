-- Representation Discovery V1: scoped crawl jobs with a durable frontier.
-- Additive, re-runnable (IF NOT EXISTS / CREATE OR REPLACE throughout).
--
-- Tenancy: every row carries business_id; scope/run/frontier/observation/
-- match rows must belong to the same business as their parents (triggers).
-- Orchestration rows (scopes, runs, frontier) are mutable job state with
-- guarded transitions; observations and matches are append-only evidence.
--
-- Discovery never creates source_targets/source_bindings and never writes
-- IN_SYNC/DRIFT findings. Candidates are derived at read time from
-- discovery_matches, never stored as verification state.

CREATE TABLE IF NOT EXISTS discovery_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  root_url TEXT NOT NULL,
  canonical_origin TEXT NOT NULL,
  path_prefix TEXT NOT NULL DEFAULT '/',
  enabled BOOLEAN NOT NULL DEFAULT true,
  ownership_assertion TEXT NOT NULL DEFAULT 'OPERATOR_ASSERTED_OWNED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_discovery_scopes_business_origin_prefix
  ON discovery_scopes(business_id, canonical_origin, path_prefix);
CREATE INDEX IF NOT EXISTS idx_discovery_scopes_business
  ON discovery_scopes(business_id, created_at);

CREATE TABLE IF NOT EXISTS discovery_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL REFERENCES discovery_scopes(id) ON DELETE CASCADE,
  authority_snapshot_digest TEXT,
  matcher_version TEXT NOT NULL DEFAULT 'discovery-matcher/1',
  policy_version TEXT NOT NULL DEFAULT 'discovery-policy/1',
  state TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED')),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0,
  failure_class TEXT,
  failure_detail_safe TEXT,
  pages_fetched INT NOT NULL DEFAULT 0,
  pages_not_modified INT NOT NULL DEFAULT 0,
  pages_failed INT NOT NULL DEFAULT 0,
  pages_skipped_robots INT NOT NULL DEFAULT 0,
  bytes_downloaded BIGINT NOT NULL DEFAULT 0,
  candidates_found INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_scope
  ON discovery_runs(scope_id, queued_at);
CREATE INDEX IF NOT EXISTS idx_discovery_runs_business
  ON discovery_runs(business_id, queued_at DESC);
-- At most one active (QUEUED or RUNNING) run per scope: duplicate POSTs get
-- a deterministic 409 from the API, and this index is the race backstop.
CREATE UNIQUE INDEX IF NOT EXISTS uq_discovery_runs_one_active_per_scope
  ON discovery_runs(scope_id)
  WHERE state IN ('QUEUED','RUNNING');

CREATE TABLE IF NOT EXISTS discovery_frontier (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  canonical_url TEXT NOT NULL,
  requested_url TEXT NOT NULL,
  discovered_via TEXT NOT NULL DEFAULT 'ROOT'
    CHECK (discovered_via IN ('ROOT','ROBOTS_SITEMAP','DEFAULT_SITEMAP','SITEMAP','LINK')),
  parent_url TEXT,
  depth INT NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING','IN_PROGRESS','DONE','SKIPPED')),
  skip_reason TEXT,
  order_key TEXT NOT NULL DEFAULT '',
  attempts INT NOT NULL DEFAULT 0,
  lease_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, canonical_url)
);
CREATE INDEX IF NOT EXISTS idx_discovery_frontier_run_state
  ON discovery_frontier(run_id, state, order_key);

CREATE TABLE IF NOT EXISTS discovery_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  scope_id UUID NOT NULL REFERENCES discovery_scopes(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('ROBOTS','SITEMAP','PAGE')),
  requested_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  discovered_via TEXT NOT NULL DEFAULT 'ROOT'
    CHECK (discovered_via IN ('ROOT','ROBOTS_SITEMAP','DEFAULT_SITEMAP','SITEMAP','LINK')),
  parent_url TEXT,
  depth INT NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  http_status INT,
  content_type TEXT,
  etag TEXT,
  last_modified TEXT,
  body_digest TEXT,
  body_bytes BIGINT NOT NULL DEFAULT 0,
  collection_state TEXT NOT NULL
    CHECK (collection_state IN ('FETCHED','NOT_MODIFIED','FAILED')),
  failure TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_run
  ON discovery_observations(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_discovery_observations_canonical
  ON discovery_observations(business_id, scope_id, canonical_url, completed_at DESC);

CREATE TABLE IF NOT EXISTS discovery_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  run_id UUID NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  page_observation_id UUID NOT NULL REFERENCES discovery_observations(id) ON DELETE CASCADE,
  lineage_root_fact_id UUID NOT NULL REFERENCES authoritative_facts(id) ON DELETE CASCADE,
  matched_fact_id UUID NOT NULL REFERENCES authoritative_facts(id) ON DELETE CASCADE,
  matched_fact_version INT NOT NULL,
  matched_value TEXT NOT NULL,
  match_surface TEXT NOT NULL CHECK (match_surface IN ('JSON_LD','META','VISIBLE_TEXT')),
  evidence_locator TEXT NOT NULL,
  evidence_snippet TEXT NOT NULL,
  relation_at_scan TEXT NOT NULL CHECK (relation_at_scan IN ('CURRENT_VALUE','HISTORICAL_VALUE')),
  matcher_version TEXT NOT NULL DEFAULT 'discovery-matcher/1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_discovery_matches_run
  ON discovery_matches(run_id, lineage_root_fact_id);
CREATE INDEX IF NOT EXISTS idx_discovery_matches_observation
  ON discovery_matches(page_observation_id);

-- Tenancy: every discovery row must share its scope/run/fact business.
CREATE OR REPLACE FUNCTION check_discovery_tenancy() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'discovery_scopes' THEN
    IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = NEW.business_id) THEN
      RAISE EXCEPTION 'discovery scope % has no business', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'discovery_runs' THEN
    IF NOT EXISTS (SELECT 1 FROM discovery_scopes s WHERE s.id = NEW.scope_id AND s.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'discovery run % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'discovery_frontier' THEN
    IF NOT EXISTS (SELECT 1 FROM discovery_runs r WHERE r.id = NEW.run_id AND r.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'discovery frontier % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'discovery_observations' THEN
    IF NOT EXISTS (
      SELECT 1 FROM discovery_runs r JOIN discovery_scopes s ON s.id = r.scope_id
      WHERE r.id = NEW.run_id AND r.business_id = NEW.business_id
        AND s.id = NEW.scope_id AND s.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'discovery observation % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'discovery_matches' THEN
    IF NOT EXISTS (
      SELECT 1 FROM discovery_observations o
      JOIN discovery_runs r ON r.id = o.run_id
      WHERE o.id = NEW.page_observation_id AND o.run_id = NEW.run_id
        AND r.business_id = NEW.business_id AND o.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'discovery match % crosses business boundary', NEW.id;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM authoritative_facts f1 JOIN authoritative_facts f2 ON f1.business_id = f2.business_id
      WHERE f1.id = NEW.lineage_root_fact_id AND f2.id = NEW.matched_fact_id
        AND f1.business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'discovery match % references facts of another business', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_discovery_scopes_tenancy ON discovery_scopes;
CREATE TRIGGER trg_discovery_scopes_tenancy BEFORE INSERT ON discovery_scopes
FOR EACH ROW EXECUTE FUNCTION check_discovery_tenancy();
DROP TRIGGER IF EXISTS trg_discovery_runs_tenancy ON discovery_runs;
CREATE TRIGGER trg_discovery_runs_tenancy BEFORE INSERT ON discovery_runs
FOR EACH ROW EXECUTE FUNCTION check_discovery_tenancy();
DROP TRIGGER IF EXISTS trg_discovery_frontier_tenancy ON discovery_frontier;
CREATE TRIGGER trg_discovery_frontier_tenancy BEFORE INSERT ON discovery_frontier
FOR EACH ROW EXECUTE FUNCTION check_discovery_tenancy();
DROP TRIGGER IF EXISTS trg_discovery_observations_tenancy ON discovery_observations;
CREATE TRIGGER trg_discovery_observations_tenancy BEFORE INSERT ON discovery_observations
FOR EACH ROW EXECUTE FUNCTION check_discovery_tenancy();
DROP TRIGGER IF EXISTS trg_discovery_matches_tenancy ON discovery_matches;
CREATE TRIGGER trg_discovery_matches_tenancy BEFORE INSERT ON discovery_matches
FOR EACH ROW EXECUTE FUNCTION check_discovery_tenancy();

-- Append-only evidence: observations and matches are never rewritten.
DROP TRIGGER IF EXISTS trg_discovery_observations_no_update ON discovery_observations;
CREATE TRIGGER trg_discovery_observations_no_update BEFORE UPDATE OR DELETE ON discovery_observations
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_discovery_matches_no_update ON discovery_matches;
CREATE TRIGGER trg_discovery_matches_no_update BEFORE UPDATE OR DELETE ON discovery_matches
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

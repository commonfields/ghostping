-- Representation Graph V1: bounded source representations.
-- Additive, re-runnable (IF NOT EXISTS throughout). Findings are derived,
-- never stored as mutable truth.
--
-- Tenancy: every row carries business_id; bindings/observations/values
-- must belong to the same business as their parents (triggers).
-- Observations/values are append-only.

CREATE TABLE IF NOT EXISTS source_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  control TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK (control IN ('OWNED','THIRD_PARTY','UNKNOWN')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_targets_business ON source_targets(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_source_targets_url ON source_targets(business_id, url);

CREATE TABLE IF NOT EXISTS source_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES authoritative_facts(id) ON DELETE CASCADE,
  source_target_id UUID NOT NULL REFERENCES source_targets(id) ON DELETE CASCADE,
  extractor_kind TEXT NOT NULL CHECK (extractor_kind IN ('JSON_LD','CSS_TEXT','META_CONTENT')),
  extractor_selector TEXT NOT NULL,
  comparator TEXT NOT NULL CHECK (comparator IN ('EXACT_TEXT','BOOLEAN','MONEY')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_bindings_business ON source_bindings(business_id, fact_id);
CREATE INDEX IF NOT EXISTS idx_source_bindings_target ON source_bindings(source_target_id);

CREATE TABLE IF NOT EXISTS source_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_target_id UUID NOT NULL REFERENCES source_targets(id) ON DELETE CASCADE,
  collector TEXT NOT NULL DEFAULT 'NATIVE_HTTP' CHECK (collector IN ('NATIVE_HTTP','PLAYWRIGHT','FIRECRAWL')),
  collector_version TEXT NOT NULL DEFAULT 'native-http/1',
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  http_status INT,
  content_type TEXT,
  etag TEXT,
  last_modified TEXT,
  body_digest TEXT,
  body_bytes INT NOT NULL DEFAULT 0,
  collection_state TEXT NOT NULL CHECK (collection_state IN ('FETCHED','NOT_MODIFIED','FAILED')),
  failure TEXT CHECK (failure IN ('TIMEOUT','REDIRECT_LIMIT','RESPONSE_TOO_LARGE','UNSUPPORTED_CONTENT_TYPE','NETWORK_ERROR','SECURITY_REJECTED','INVALID_URL')),
  raw_evidence_id UUID REFERENCES raw_evidence(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_observations_target ON source_observations(source_target_id, completed_at);
CREATE INDEX IF NOT EXISTS idx_source_observations_business ON source_observations(business_id, completed_at);

CREATE TABLE IF NOT EXISTS observed_source_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_observation_id UUID NOT NULL REFERENCES source_observations(id) ON DELETE CASCADE,
  source_binding_id UUID NOT NULL REFERENCES source_bindings(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL REFERENCES authoritative_facts(id) ON DELETE CASCADE,
  extracted_value TEXT,
  extraction_state TEXT NOT NULL CHECK (extraction_state IN ('OBSERVED','NOT_FOUND','AMBIGUOUS','UNSUPPORTED','FAILED')),
  evidence_selector TEXT NOT NULL,
  evidence_observation_id UUID NOT NULL REFERENCES source_observations(id) ON DELETE CASCADE,
  evidence_node_identity TEXT,
  extractor_version TEXT NOT NULL DEFAULT 'extractors/1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_observed_values_observation ON observed_source_values(source_observation_id);
CREATE INDEX IF NOT EXISTS idx_observed_values_binding ON observed_source_values(source_binding_id, created_at);

-- Tenancy: binding/fact/target, observation/target, value/observation/binding/fact share business_id.
CREATE OR REPLACE FUNCTION check_representation_tenancy() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'source_bindings' THEN
    IF NOT EXISTS (SELECT 1 FROM source_targets t JOIN authoritative_facts f ON f.business_id = t.business_id WHERE t.id = NEW.source_target_id AND f.id = NEW.fact_id AND t.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'source binding % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'source_observations' THEN
    IF NOT EXISTS (SELECT 1 FROM source_targets t WHERE t.id = NEW.source_target_id AND t.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'source observation % crosses business boundary', NEW.id;
    END IF;
  ELSIF TG_TABLE_NAME = 'observed_source_values' THEN
    IF NOT EXISTS (
      SELECT 1 FROM source_observations o JOIN source_bindings b ON b.business_id = o.business_id
      JOIN authoritative_facts f ON f.business_id = o.business_id
      WHERE o.id = NEW.source_observation_id AND b.id = NEW.source_binding_id AND f.id = NEW.fact_id
        AND o.business_id = NEW.business_id AND b.business_id = NEW.business_id AND f.business_id = NEW.business_id
        AND NEW.evidence_observation_id = NEW.source_observation_id
    ) THEN
      RAISE EXCEPTION 'observed value % crosses business boundary', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_source_bindings_tenancy ON source_bindings;
CREATE TRIGGER trg_source_bindings_tenancy BEFORE INSERT ON source_bindings
FOR EACH ROW EXECUTE FUNCTION check_representation_tenancy();
DROP TRIGGER IF EXISTS trg_source_observations_tenancy ON source_observations;
CREATE TRIGGER trg_source_observations_tenancy BEFORE INSERT ON source_observations
FOR EACH ROW EXECUTE FUNCTION check_representation_tenancy();
DROP TRIGGER IF EXISTS trg_observed_values_tenancy ON observed_source_values;
CREATE TRIGGER trg_observed_values_tenancy BEFORE INSERT ON observed_source_values
FOR EACH ROW EXECUTE FUNCTION check_representation_tenancy();

-- Append-only observations and values.
DROP TRIGGER IF EXISTS trg_source_observations_no_update ON source_observations;
CREATE TRIGGER trg_source_observations_no_update BEFORE UPDATE OR DELETE ON source_observations
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_observed_values_no_update ON observed_source_values;
CREATE TRIGGER trg_observed_values_no_update BEFORE UPDATE OR DELETE ON observed_source_values
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

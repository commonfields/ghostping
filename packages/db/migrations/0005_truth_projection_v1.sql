-- Truth Projection V1: one active authority writer per business.
-- Additive, re-runnable (IF NOT EXISTS / CREATE OR REPLACE throughout).
-- Existing businesses have no row here and keep behaving as HOSTED.

CREATE TABLE IF NOT EXISTS business_authority_mode (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  writer TEXT NOT NULL CHECK (writer IN ('HOSTED','REPOSITORY_MANIFEST')),
  set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per synchronized fact VERSION: key/digest/revision/provenance.
-- History is preserved; idempotency is enforced in the sync service
-- (active-first check), not by a uniqueness constraint that would forbid
-- re-creating a retired key.
CREATE TABLE IF NOT EXISTS repository_fact_provenance (
  fact_id UUID PRIMARY KEY REFERENCES authoritative_facts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  manifest_key TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  source_revision TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  writer TEXT NOT NULL DEFAULT 'REPOSITORY_MANIFEST' CHECK (writer IN ('REPOSITORY_MANIFEST'))
);
CREATE INDEX IF NOT EXISTS idx_provenance_business_key ON repository_fact_provenance(business_id, manifest_key);

-- Mode changes are prohibited once facts exist.
CREATE OR REPLACE FUNCTION check_authority_mode_transition() RETURNS trigger AS $$
DECLARE
  fact_count INT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.writer = OLD.writer THEN
    RETURN NEW;
  END IF;
  SELECT COUNT(*) INTO fact_count FROM authoritative_facts WHERE business_id = NEW.business_id;
  IF fact_count > 0 THEN
    RAISE EXCEPTION 'authority mode for business % is immutable once facts exist', NEW.business_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_authority_mode_transition ON business_authority_mode;
CREATE TRIGGER trg_authority_mode_transition BEFORE INSERT OR UPDATE ON business_authority_mode
FOR EACH ROW EXECUTE FUNCTION check_authority_mode_transition();

-- Direct hosted writes fail closed for repository-managed businesses.
-- The manifest sync runs inside a transaction with
-- SET LOCAL openrecord.authority_sync = '1'; the hosted API never sets it.
CREATE OR REPLACE FUNCTION check_fact_authority() RETURNS trigger AS $$
DECLARE
  mode TEXT;
  sync_flag TEXT;
BEGIN
  SELECT writer INTO mode FROM business_authority_mode WHERE business_id = NEW.business_id;
  IF mode = 'REPOSITORY_MANIFEST' THEN
    BEGIN
      sync_flag := current_setting('openrecord.authority_sync', true);
    EXCEPTION WHEN OTHERS THEN
      sync_flag := NULL;
    END;
    IF sync_flag IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'fact of business % is managed by repository manifest', NEW.business_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_facts_authority_insert ON authoritative_facts;
CREATE TRIGGER trg_facts_authority_insert BEFORE INSERT ON authoritative_facts
FOR EACH ROW EXECUTE FUNCTION check_fact_authority();
DROP TRIGGER IF EXISTS trg_facts_authority_update ON authoritative_facts;
CREATE TRIGGER trg_facts_authority_update BEFORE UPDATE ON authoritative_facts
FOR EACH ROW EXECUTE FUNCTION check_fact_authority();

-- Provenance rows are immutable history.
DROP TRIGGER IF EXISTS trg_provenance_no_update ON repository_fact_provenance;
CREATE TRIGGER trg_provenance_no_update BEFORE UPDATE OR DELETE ON repository_fact_provenance
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

-- Tenancy: provenance business must match the fact's business.
CREATE OR REPLACE FUNCTION check_provenance_tenancy() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM authoritative_facts f WHERE f.id = NEW.fact_id AND f.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'provenance % crosses business boundary', NEW.fact_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_provenance_tenancy ON repository_fact_provenance;
CREATE TRIGGER trg_provenance_tenancy BEFORE INSERT ON repository_fact_provenance
FOR EACH ROW EXECUTE FUNCTION check_provenance_tenancy();

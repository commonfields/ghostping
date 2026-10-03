-- Truth Projection closeout: single ACTIVE lineage per manifest key, and
-- repository history protection against ordinary direct DELETE.
-- Additive, re-runnable (CREATE OR REPLACE / DROP TRIGGER IF EXISTS).

-- At most one ACTIVE repository-managed fact per (business, manifest key).
-- Serialization comes from the per-business lock in the sync transaction
-- (SELECT ... FOR UPDATE on businesses); this trigger is the backstop that
-- makes a forked second ACTIVE head impossible even for direct SQL.
CREATE OR REPLACE FUNCTION check_single_active_manifest_fact() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM authoritative_facts f
    JOIN repository_fact_provenance p ON p.fact_id = f.id
    WHERE p.business_id = NEW.business_id
      AND p.manifest_key = NEW.manifest_key
      AND f.status = 'ACTIVE'
      AND f.id <> NEW.fact_id
  ) THEN
    RAISE EXCEPTION 'duplicate ACTIVE fact for manifest key % of business %', NEW.manifest_key, NEW.business_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_single_active_manifest_fact ON repository_fact_provenance;
CREATE TRIGGER trg_single_active_manifest_fact BEFORE INSERT ON repository_fact_provenance
FOR EACH ROW EXECUTE FUNCTION check_single_active_manifest_fact();

-- Repository-managed fact history cannot be erased through ordinary DELETE.
-- Direct fact deletion is rejected while the owning business exists.
-- Destruction of the owning business/account still cascades: by the time a
-- cascaded child delete fires, the parent row is already gone, so the guard
-- below observes a missing parent and permits aggregate destruction.
-- (Fact-history mutation is not the same operation as destroying the owner.)
CREATE OR REPLACE FUNCTION check_fact_delete() RETURNS trigger AS $$
DECLARE
  mode TEXT;
  parent_alive BOOLEAN;
BEGIN
  SELECT writer INTO mode FROM business_authority_mode WHERE business_id = OLD.business_id;
  IF mode = 'REPOSITORY_MANIFEST' THEN
    SELECT EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id) INTO parent_alive;
    IF parent_alive THEN
      RAISE EXCEPTION 'repository-managed fact history of business % cannot be directly deleted; retire it instead', OLD.business_id;
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_facts_no_direct_delete ON authoritative_facts;
CREATE TRIGGER trg_facts_no_direct_delete BEFORE DELETE ON authoritative_facts
FOR EACH ROW EXECUTE FUNCTION check_fact_delete();

-- Provenance rows are immutable history, but aggregate destruction still
-- cascades: a provenance row may disappear only together with its owning
-- business (same parent-alive distinction as fact deletes). This replaces
-- the blanket 0005 append-only DELETE block, which would otherwise make
-- legal business destruction impossible.
DROP TRIGGER IF EXISTS trg_provenance_no_update ON repository_fact_provenance;
CREATE TRIGGER trg_provenance_no_update BEFORE UPDATE ON repository_fact_provenance
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE OR REPLACE FUNCTION check_provenance_delete() RETURNS trigger AS $$
DECLARE
  parent_alive BOOLEAN;
BEGIN
  SELECT EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id) INTO parent_alive;
  IF parent_alive THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_provenance_delete_guarded ON repository_fact_provenance;
CREATE TRIGGER trg_provenance_delete_guarded BEFORE DELETE ON repository_fact_provenance
FOR EACH ROW EXECUTE FUNCTION check_provenance_delete();

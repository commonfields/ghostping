-- Truth verification lineage: repository-managed bindings track a stable
-- logical identity (manifest key + target + extractor + comparator) across
-- fact-version UUID changes, instead of accumulating one row per version.
-- Additive, re-runnable. Hosted/manual bindings keep managed_key NULL and
-- retain existing exact-match identity semantics.

ALTER TABLE source_bindings ADD COLUMN IF NOT EXISTS managed_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_source_bindings_managed
  ON source_bindings(business_id, managed_key, source_target_id, extractor_kind, extractor_selector, comparator)
  WHERE managed_key IS NOT NULL;

-- The existing tenancy check also guards fact_id changes on UPDATE.
DROP TRIGGER IF EXISTS trg_source_bindings_tenancy_update ON source_bindings;
CREATE TRIGGER trg_source_bindings_tenancy_update BEFORE UPDATE ON source_bindings
FOR EACH ROW EXECUTE FUNCTION check_representation_tenancy();

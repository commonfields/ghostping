-- Explicit intervention→source-binding linkage (loop closeout follow-up V1).
--
-- Re-runnable by design (the runner applies every file on each migrate):
-- IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS throughout.
--
-- An intervention_source_bindings row names the tracked source binding a
-- recorded action acted on, plus the best known pre-intervention evidence:
-- the latest successful source observation of that binding's target
-- collected at or before the intervention's performed_at (resolved and
-- persisted by the API at record time, never manufactured from current
-- values, never hashed from URLs). NULL means no successful observation
-- existed yet (UNKNOWN downstream, never backfilled).
--
-- Stored here: linkage only (business, intervention, binding, optional
-- before-observation, timestamp). NOT stored: match classification,
-- observed change, outcome, or causal claims. Those derive at read/export
-- time, so there is exactly one implementation of those rules.
--
-- Historical interventions without rows read as unlinked (UNKNOWN
-- downstream). Rows are append-only: the link is part of the recorded
-- event and is never rewritten.
CREATE TABLE IF NOT EXISTS intervention_source_bindings (
  intervention_id UUID NOT NULL REFERENCES interventions(id) ON DELETE CASCADE,
  business_id UUID NOT NULL,
  source_binding_id UUID NOT NULL REFERENCES source_bindings(id) ON DELETE CASCADE,
  before_source_observation_id UUID NULL REFERENCES source_observations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (intervention_id, source_binding_id)
);
CREATE INDEX IF NOT EXISTS idx_intervention_source_bindings_business
  ON intervention_source_bindings(business_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intervention_source_bindings_binding
  ON intervention_source_bindings(source_binding_id);

CREATE OR REPLACE FUNCTION check_intervention_source_binding_tenancy() RETURNS trigger AS $$
DECLARE
  v_intervention_business UUID;
  v_binding_business UUID;
  v_binding_target UUID;
BEGIN
  SELECT business_id INTO v_intervention_business FROM interventions WHERE id = NEW.intervention_id;
  SELECT business_id, source_target_id INTO v_binding_business, v_binding_target FROM source_bindings WHERE id = NEW.source_binding_id;
  IF v_intervention_business IS NULL OR v_binding_business IS NULL THEN
    RAISE EXCEPTION 'intervention source binding references an unknown intervention or binding';
  END IF;
  -- The intervention, the binding, and the link row share one business:
  -- cross-business bindings are rejected, never stored.
  IF v_intervention_business <> NEW.business_id OR v_binding_business <> NEW.business_id THEN
    RAISE EXCEPTION 'intervention % and source binding % belong to different businesses', NEW.intervention_id, NEW.source_binding_id;
  END IF;
  IF NEW.before_source_observation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM source_observations o
    WHERE o.id = NEW.before_source_observation_id
      AND o.business_id = NEW.business_id
      AND o.source_target_id = v_binding_target
      AND o.collection_state IN ('FETCHED', 'NOT_MODIFIED')
      AND o.failure IS NULL
  ) THEN
    RAISE EXCEPTION 'before source observation % is not successful evidence of this binding''s target', NEW.before_source_observation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_intervention_source_bindings_tenancy ON intervention_source_bindings;
CREATE TRIGGER trg_intervention_source_bindings_tenancy BEFORE INSERT ON intervention_source_bindings
FOR EACH ROW EXECUTE FUNCTION check_intervention_source_binding_tenancy();
DROP TRIGGER IF EXISTS trg_intervention_source_bindings_no_update ON intervention_source_bindings;
CREATE TRIGGER trg_intervention_source_bindings_no_update BEFORE UPDATE OR DELETE ON intervention_source_bindings
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_intervention_source_bindings_no_truncate ON intervention_source_bindings;
CREATE TRIGGER trg_intervention_source_bindings_no_truncate BEFORE TRUNCATE ON intervention_source_bindings
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

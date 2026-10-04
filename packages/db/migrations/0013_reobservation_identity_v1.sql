-- Re-observation measurement identity + single-active backstop (loop closeout).
--
-- Re-runnable (CREATE OR REPLACE / DROP TRIGGER IF EXISTS throughout).
-- Additive: triggers only, no column or table changes. Safe for existing
-- rows: both triggers fire BEFORE INSERT, so stored history is untouched.
--
-- 1. Measurement identity: the intent's check run must repeat the original
--    check run's REQUESTED identity (business, question, provider,
--    requested model with NULL-safe equality). Observed model, timestamps,
--    retrieval results, and citations are provider output, never identity,
--    and are intentionally not compared. BuyerQuestions are insert-only in
--    this repository (no UPDATE path exists), so the same question_id pins
--    the exact immutable prompt; protocol comparison remains the final
--    evidence authority over prompt digest and measurement context.
--
-- 2. Single active attempt: at most one intent per issue may reference a
--    QUEUED or RUNNING check run. Terminal (FAILED/SUCCEEDED) runs never
--    block a later recheck, preserving attempt history.
CREATE OR REPLACE FUNCTION check_reobservation_intent_measurement_identity() RETURNS trigger AS $$
DECLARE
  orig_check UUID;
  orig_question UUID;
  orig_provider TEXT;
  orig_model TEXT;
  new_question UUID;
  new_provider TEXT;
  new_model TEXT;
BEGIN
  SELECT o.check_run_id INTO orig_check
  FROM observations o WHERE o.id = NEW.original_observation_id;
  IF orig_check IS NULL THEN
    RAISE EXCEPTION 'reobservation intent original observation % has no check run', NEW.original_observation_id;
  END IF;
  SELECT cr.question_id, cr.provider, cr.requested_model INTO orig_question, orig_provider, orig_model
  FROM check_runs cr WHERE cr.id = orig_check;
  IF orig_question IS NULL THEN
    RAISE EXCEPTION 'reobservation intent original check run % is missing', orig_check;
  END IF;
  SELECT cr.question_id, cr.provider, cr.requested_model INTO new_question, new_provider, new_model
  FROM check_runs cr WHERE cr.id = NEW.check_run_id;
  IF new_question IS NULL THEN
    RAISE EXCEPTION 'reobservation intent check run % is missing', NEW.check_run_id;
  END IF;
  IF new_question IS DISTINCT FROM orig_question THEN
    RAISE EXCEPTION 'reobservation intent check run uses a different question than the original measurement';
  END IF;
  IF new_provider IS DISTINCT FROM orig_provider THEN
    RAISE EXCEPTION 'reobservation intent check run uses a different provider than the original measurement';
  END IF;
  IF new_model IS NOT DISTINCT FROM orig_model THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'reobservation intent check run uses a different requested model than the original measurement';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reobservation_intents_measurement_identity ON reobservation_intents;
CREATE TRIGGER trg_reobservation_intents_measurement_identity BEFORE INSERT ON reobservation_intents
FOR EACH ROW EXECUTE FUNCTION check_reobservation_intent_measurement_identity();

CREATE OR REPLACE FUNCTION check_reobservation_intent_single_active() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM reobservation_intents i
    JOIN check_runs cr ON cr.id = i.check_run_id
    WHERE i.issue_id = NEW.issue_id AND i.id IS DISTINCT FROM NEW.id
      AND cr.status IN ('QUEUED', 'RUNNING')
  ) THEN
    RAISE EXCEPTION 'issue % already has an active re-observation', NEW.issue_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reobservation_intents_single_active ON reobservation_intents;
CREATE TRIGGER trg_reobservation_intents_single_active BEFORE INSERT ON reobservation_intents
FOR EACH ROW EXECUTE FUNCTION check_reobservation_intent_single_active();

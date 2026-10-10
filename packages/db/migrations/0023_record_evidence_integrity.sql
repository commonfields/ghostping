-- Record approvals and comparisons bind to exact fact/question versions.
-- Preserve that content even when another internal write path reaches it.
-- Status changes remain allowed so existing fact supersession still works.
CREATE OR REPLACE FUNCTION guard_record_fact_content() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM record_items WHERE fact_id = OLD.id)
    AND (to_jsonb(NEW) - 'status') IS DISTINCT FROM (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'record fact content is immutable; append a new version';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_fact_content ON authoritative_facts;
CREATE TRIGGER trg_record_fact_content BEFORE UPDATE ON authoritative_facts
FOR EACH ROW EXECUTE FUNCTION guard_record_fact_content();

CREATE OR REPLACE FUNCTION guard_record_question_content() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM record_items WHERE question_id = OLD.id)
    AND (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'record question content is immutable; append a new version';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_question_content ON buyer_questions;
CREATE TRIGGER trg_record_question_content BEFORE UPDATE ON buyer_questions
FOR EACH ROW EXECUTE FUNCTION guard_record_question_content();

CREATE OR REPLACE FUNCTION guard_record_check_identity() RETURNS trigger AS $$
BEGIN
  IF OLD.record_run_id IS NOT NULL AND
    ROW(NEW.business_id, NEW.question_id, NEW.provider, NEW.requested_model)
      IS DISTINCT FROM ROW(OLD.business_id, OLD.question_id, OLD.provider, OLD.requested_model) THEN
    RAISE EXCEPTION 'record check identity is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_check_identity ON check_runs;
CREATE TRIGGER trg_record_check_identity BEFORE UPDATE ON check_runs
FOR EACH ROW EXECUTE FUNCTION guard_record_check_identity();

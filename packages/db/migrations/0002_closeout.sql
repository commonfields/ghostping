-- Hosted V1 closeout migration (unshipped schema: safe to evolve).
-- 1. check_runs.attempt_count: every real worker invocation is counted.
-- 2. human_judgments: drop the misleading mutable `superseded` flag; the
--    current head is derived from the supersedes_id chain (see repositories).
-- 3. Append-only enforcement for judgments + judgment<->fact links.

ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0;

-- Remove the unpublished mutable supersession flag. Older dev DBs created by
-- 0001 carry the column; fresh DBs never had it in the canonical model.
ALTER TABLE human_judgments DROP COLUMN IF EXISTS superseded;

-- Reuse the existing append-only guard function from 0001.
-- human_judgments rows must never be rewritten once created.
DROP TRIGGER IF EXISTS trg_human_judgments_no_update ON human_judgments;
CREATE TRIGGER trg_human_judgments_no_update BEFORE UPDATE OR DELETE ON human_judgments
FOR EACH ROW EXECUTE FUNCTION prevent_observation_mutation();

-- Judgment<->fact associations are established at creation time and then frozen.
DROP TRIGGER IF EXISTS trg_human_judgment_facts_no_update ON human_judgment_facts;
CREATE TRIGGER trg_human_judgment_facts_no_update BEFORE UPDATE OR DELETE ON human_judgment_facts
FOR EACH ROW EXECUTE FUNCTION prevent_observation_mutation();

-- Observation citations are part of the immutable observation record.
DROP TRIGGER IF EXISTS trg_observation_citations_no_update ON observation_citations;
CREATE TRIGGER trg_observation_citations_no_update BEFORE UPDATE OR DELETE ON observation_citations
FOR EACH ROW EXECUTE FUNCTION prevent_observation_mutation();

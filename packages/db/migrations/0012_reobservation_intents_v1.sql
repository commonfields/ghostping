-- Durable re-observation intents (loop foundation V1).
--
-- Re-runnable by design (the runner applies every file on each migrate):
-- IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS throughout.
--
-- A reobservation_intents row is the durable request for one re-check of an
-- issue. The POST /reobservations route enqueues a QUEUED check_runs row
-- first and stores its id here at creation time (check_run_id is NOT NULL:
-- "nullable until queued" is decided as stored-at-creation, so every intent
-- names the exact run that will fulfill it).
--
-- Stored here: linkage only (business, issue, original observation,
-- optional intervention, fulfilling check run, author, timestamp). NOT
-- stored: match classification, observed change, outcome, "corrected"
-- flags, or causal claims. Those are derived by @openrecord/protocol at
-- read/export time from the reobservations rows the worker finalizes, so
-- there is exactly one implementation of those rules.
--
-- There is deliberately NO status column: an intent is fulfilled exactly
-- when a reobservations row exists for the observation collected by its
-- check run (join reobservations to observations on observation_id, then to
-- this table on check_run_id). Failed checks leave the intent row in place
-- with no link, which is how PENDING/FAILED attempts read.
CREATE TABLE IF NOT EXISTS reobservation_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  issue_id UUID NOT NULL REFERENCES candidate_claims(id),
  original_observation_id UUID NOT NULL REFERENCES observations(id),
  intervention_id UUID REFERENCES interventions(id),
  check_run_id UUID NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
  -- Session user that requested the recheck. No users FK: evidence rows
  -- outlive account membership, and tenancy is enforced by the trigger
  -- below plus the route's business scoping (the id itself always comes
  -- from the authenticated session, never request JSON).
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One durable request per check run: API retries and worker recovery can
  -- never attach two intents to the same run.
  UNIQUE (business_id, check_run_id)
);
-- One intent per check run globally (the composite above is per business;
-- this index makes the worker's claim-by-check_run_id unambiguous).
CREATE UNIQUE INDEX IF NOT EXISTS uq_reobservation_intents_check_run ON reobservation_intents(check_run_id);
CREATE INDEX IF NOT EXISTS idx_reobservation_intents_issue ON reobservation_intents(issue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reobservation_intents_business_check ON reobservation_intents(business_id, check_run_id);

CREATE OR REPLACE FUNCTION check_reobservation_intent_tenancy() RETURNS trigger AS $$
BEGIN
  -- The issue's claim must belong to this business and to the original
  -- observation: the original observation always belongs to the issue
  -- lineage, never supplied independently.
  IF NOT EXISTS (
    SELECT 1 FROM candidate_claims c
    WHERE c.id = NEW.issue_id AND c.business_id = NEW.business_id AND c.observation_id = NEW.original_observation_id
  ) THEN
    RAISE EXCEPTION 'reobservation intent issue % does not belong to original observation % of business %', NEW.issue_id, NEW.original_observation_id, NEW.business_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM observations o WHERE o.id = NEW.original_observation_id AND o.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'reobservation intent original observation must belong to business %', NEW.business_id;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM check_runs cr WHERE cr.id = NEW.check_run_id AND cr.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'reobservation intent check run must belong to business %', NEW.business_id;
  END IF;
  IF NEW.intervention_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM intervention_issues ii JOIN interventions i ON i.id = ii.intervention_id
    WHERE ii.intervention_id = NEW.intervention_id AND ii.issue_id = NEW.issue_id AND i.business_id = NEW.business_id
  ) THEN
    RAISE EXCEPTION 'intervention % is not linked to issue %', NEW.intervention_id, NEW.issue_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reobservation_intents_tenancy ON reobservation_intents;
CREATE TRIGGER trg_reobservation_intents_tenancy BEFORE INSERT ON reobservation_intents
FOR EACH ROW EXECUTE FUNCTION check_reobservation_intent_tenancy();
DROP TRIGGER IF EXISTS trg_reobservation_intents_no_update ON reobservation_intents;
CREATE TRIGGER trg_reobservation_intents_no_update BEFORE UPDATE OR DELETE ON reobservation_intents
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_reobservation_intents_no_truncate ON reobservation_intents;
CREATE TRIGGER trg_reobservation_intents_no_truncate BEFORE TRUNCATE ON reobservation_intents
FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

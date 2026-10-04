-- Convergence for long-lived databases: ensure the composite reobservation
-- identity the worker relies on.
--
-- Re-runnable (DO blocks probe the catalog; nothing is assumed).
-- Additive and safe: only adds a missing UNIQUE and drops an obsolete
-- single-column UNIQUE that contradicts the current model. Existing rows
-- are never rewritten. Fresh databases already match (migration 0003
-- declares the composite); this converges databases first migrated from
-- older tree states, where CREATE TABLE IF NOT EXISTS froze the first
-- definition it ever saw. Without the composite, the idempotent
-- finalize/sweep INSERT ... ON CONFLICT (issue_id, observation_id) fails
-- with 42P10 and re-observation links are never written.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'reobservations'::regclass AND contype = 'u'
      AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
           WHERE a.attrelid = conrelid AND a.attnum = ANY (conkey)) = ARRAY['issue_id', 'observation_id']
  ) THEN
    ALTER TABLE reobservations ADD CONSTRAINT reobservations_issue_observation_key UNIQUE (issue_id, observation_id);
  END IF;
END;
$$;

-- The obsolete single-column UNIQUE(observation_id) contradicts the current
-- model (one observation may back links for more than one issue). Drop it
-- wherever it still exists; the composite above remains the backstop.
DO $$
DECLARE
  cname TEXT;
BEGIN
  SELECT c.conname INTO cname
  FROM pg_constraint c
  WHERE c.conrelid = 'reobservations'::regclass AND c.contype = 'u'
    AND (SELECT array_agg(a.attname::text ORDER BY a.attnum) FROM pg_attribute a
         WHERE a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)) = ARRAY['observation_id']
  LIMIT 1;
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE reobservations DROP CONSTRAINT %I', cname);
  END IF;
END;
$$;

-- Obsolete measurement columns from an older tree state (signatures are
-- derived at read/export time in the current model, never stored). They are
-- NOT NULL without defaults, so any database still carrying them rejects
-- every reobservations insert. No current code reads them; drop them where
-- present so long-lived databases converge with fresh ones.
ALTER TABLE reobservations DROP COLUMN IF EXISTS before_signature;
ALTER TABLE reobservations DROP COLUMN IF EXISTS after_signature;
ALTER TABLE reobservations DROP COLUMN IF EXISTS match_classification;

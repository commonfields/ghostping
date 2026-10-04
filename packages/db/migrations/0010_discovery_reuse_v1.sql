-- Representation Discovery V1 closeout: explicit 304 reuse provenance.
-- Additive, re-runnable. A compatible 304 creates current-run match rows
-- that reference the prior effective match they reuse; ancestry stays
-- traceable one hop at a time (run3 -> run2 -> run1). No blind copying:
-- reuse is valid only under identical authority digest + matcher version,
-- enforced by the runner query, not by this column.

ALTER TABLE discovery_matches
  ADD COLUMN IF NOT EXISTS reused_from_match_id UUID NULL REFERENCES discovery_matches(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_discovery_matches_reused_from
  ON discovery_matches(reused_from_match_id) WHERE reused_from_match_id IS NOT NULL;

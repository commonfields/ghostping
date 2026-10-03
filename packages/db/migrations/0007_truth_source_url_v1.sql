-- Truth Projection semantic fix: persist the manifest source URL per fact
-- version so authority comparison can detect source changes. Additive and
-- re-runnable. Existing rows keep NULL (unknown), which only ever equals
-- unknown and therefore fails safe toward a new version, never a missed one.
ALTER TABLE repository_fact_provenance ADD COLUMN IF NOT EXISTS source_url TEXT;

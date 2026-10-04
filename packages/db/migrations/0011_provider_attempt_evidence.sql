-- Failed upstream responses are immutable evidence, not successful observations.
-- No public route exposes this operator evidence. Tenant ownership is checked
-- by the repository's INSERT..SELECT and the composite foreign key.
ALTER TABLE raw_evidence ALTER COLUMN content_type DROP NOT NULL;
ALTER TABLE raw_evidence ADD COLUMN IF NOT EXISTS response_max_bytes INT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_check_run_business ON check_runs(id, business_id);
CREATE TABLE IF NOT EXISTS provider_attempt_evidence (
  check_run_id UUID NOT NULL,
  business_id UUID NOT NULL,
  attempt INT NOT NULL CHECK (attempt > 0),
  failure_class TEXT NOT NULL,
  status INT,
  digest TEXT NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  raw_bytes_hex TEXT NOT NULL CHECK (raw_bytes_hex ~ '^([a-f0-9]{2})*$'),
  content_type TEXT,
  response_max_bytes INT NOT NULL CHECK (response_max_bytes BETWEEN 1 AND 16777216),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (check_run_id, attempt),
  FOREIGN KEY (check_run_id, business_id) REFERENCES check_runs(id, business_id),
  CHECK (length(raw_bytes_hex) <= response_max_bytes * 2)
);
DROP TRIGGER IF EXISTS trg_provider_attempt_evidence_no_update ON provider_attempt_evidence;
CREATE TRIGGER trg_provider_attempt_evidence_no_update BEFORE UPDATE OR DELETE ON provider_attempt_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_observation_mutation();

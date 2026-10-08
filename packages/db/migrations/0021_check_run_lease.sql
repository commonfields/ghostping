-- 0021_check_run_lease.sql — bounded recovery of abandoned RUNNING checks.
--
-- A worker that dies after claiming a check left it RUNNING forever, and an
-- assay sample group waiting on it stayed QUEUED forever. heartbeat_at is
-- refreshed on claim and before every provider attempt; a RUNNING row whose
-- heartbeat (or start, for rows claimed before this column existed) is older
-- than the worker lease is finished as FAILED / WORKER_LOST. Recovery never
-- re-queues: a new provider call only happens through an explicit new run.
ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_check_runs_running_lease
  ON check_runs (COALESCE(heartbeat_at, started_at, queued_at)) WHERE status = 'RUNNING';

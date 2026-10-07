-- PHASED_PILOT_VALIDATION_V1 / Phase 1: mutation preconditions.
-- Additive and re-runnable (every migration is re-applied on each run).
--
-- An approval binds to one exact change: the proposal records the prepared
-- plan (target path, before/after sha256, patch sha256) and approval copies
-- patch_sha256 into approved_patch_sha256. A mutation row is claimed with an
-- idempotency key before any write; reapplying the same key returns the
-- original row. Bound columns are immutable once a mutation is claimed.

ALTER TABLE site_fix_proposals
  ADD COLUMN IF NOT EXISTS base_ref TEXT,
  ADD COLUMN IF NOT EXISTS before_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS after_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS patch_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS prepared_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_patch_sha256 TEXT;

ALTER TABLE site_fix_proposals DROP CONSTRAINT IF EXISTS site_fix_proposals_plan_ck;
ALTER TABLE site_fix_proposals ADD CONSTRAINT site_fix_proposals_plan_ck CHECK (
  (patch_sha256 IS NULL AND before_sha256 IS NULL AND after_sha256 IS NULL)
  OR (
    patch_sha256 ~ '^[0-9a-f]{64}$' AND before_sha256 ~ '^[0-9a-f]{64}$'
    AND after_sha256 ~ '^[0-9a-f]{64}$' AND file_path IS NOT NULL AND prepared_at IS NOT NULL
  )
);
ALTER TABLE site_fix_proposals DROP CONSTRAINT IF EXISTS site_fix_proposals_approved_hash_ck;
ALTER TABLE site_fix_proposals ADD CONSTRAINT site_fix_proposals_approved_hash_ck CHECK (
  approved_patch_sha256 IS NULL OR approved_patch_sha256 ~ '^[0-9a-f]{64}$'
);

ALTER TABLE site_mutations
  ADD COLUMN IF NOT EXISTS target_path TEXT,
  ADD COLUMN IF NOT EXISTS base_ref TEXT,
  ADD COLUMN IF NOT EXISTS before_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS after_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS approved_patch_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS approved_by TEXT,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS applied_after_sha256 TEXT;

ALTER TABLE site_mutations DROP CONSTRAINT IF EXISTS site_mutations_state_check;
ALTER TABLE site_mutations ADD CONSTRAINT site_mutations_state_check
  CHECK (state IN ('APPLYING','CREATED','BRANCH_CREATED','PR_OPEN','MERGED','FAILED'));

ALTER TABLE site_mutations DROP CONSTRAINT IF EXISTS site_mutations_failure_code_ck;
ALTER TABLE site_mutations ADD CONSTRAINT site_mutations_failure_code_ck CHECK (
  failure_code IS NULL
  OR failure_code IN ('PRECONDITION_FAILED','APPROVAL_INVALIDATED','MUTATION_FAILED','PATH_REJECTED','ADAPTER_FAILURE')
);

-- Keyed (Phase 1+) mutations must carry the full binding.
ALTER TABLE site_mutations DROP CONSTRAINT IF EXISTS site_mutations_binding_ck;
ALTER TABLE site_mutations ADD CONSTRAINT site_mutations_binding_ck CHECK (
  idempotency_key IS NULL OR (
    target_path IS NOT NULL
    AND before_sha256 ~ '^[0-9a-f]{64}$'
    AND after_sha256 ~ '^[0-9a-f]{64}$'
    AND approved_patch_sha256 ~ '^[0-9a-f]{64}$'
    AND approved_by IS NOT NULL
    AND approved_at IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_site_mutations_idempotency
  ON site_mutations(business_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- What was approved and claimed never changes afterwards (including the
-- business/proposal/finding it belongs to). Only lifecycle columns move.
CREATE OR REPLACE FUNCTION guard_site_mutation_binding() RETURNS trigger AS $$
BEGIN
  IF OLD.idempotency_key IS NOT NULL AND (
    NEW.business_id IS DISTINCT FROM OLD.business_id
    OR NEW.fix_proposal_id IS DISTINCT FROM OLD.fix_proposal_id
    OR NEW.finding_id IS DISTINCT FROM OLD.finding_id
    OR NEW.adapter_kind IS DISTINCT FROM OLD.adapter_kind
    OR NEW.target_path IS DISTINCT FROM OLD.target_path
    OR NEW.base_ref IS DISTINCT FROM OLD.base_ref
    OR NEW.before_sha256 IS DISTINCT FROM OLD.before_sha256
    OR NEW.after_sha256 IS DISTINCT FROM OLD.after_sha256
    OR NEW.approved_patch_sha256 IS DISTINCT FROM OLD.approved_patch_sha256
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
  ) THEN
    RAISE EXCEPTION 'site mutation % binding is immutable', OLD.id;
  END IF;
  IF OLD.idempotency_key IS NULL AND NEW.idempotency_key IS NOT NULL THEN
    RAISE EXCEPTION 'site mutation % cannot acquire a binding after creation', OLD.id;
  END IF;
  IF OLD.failure_code IS NOT NULL AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.failure_code IS DISTINCT FROM OLD.failure_code) THEN
    RAISE EXCEPTION 'site mutation % failed and is final', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_site_mutations_binding ON site_mutations;
CREATE TRIGGER trg_site_mutations_binding BEFORE UPDATE ON site_mutations
FOR EACH ROW EXECUTE FUNCTION guard_site_mutation_binding();

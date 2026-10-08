-- 0022_client_record_v1.sql — the shareable client record (ONE_AGENCY_THREE_CLIENTS_V1).
--
-- Account = agency, Business = agency client. The record is a read model
-- over evidence that already exists: authoritative_facts, buyer_questions,
-- check_runs, observations (exact answer, raw evidence, citations) and
-- interventions (the agency's action). This migration adds only what that
-- evidence lacks for a client-facing record:
--
--   record_profiles        client website and engagement label (CLIENT / DOGFOOD / FIXTURE)
--   record_items           the tracked fact + source + question per slot 1..3; append-only, superseded
--   record_item_approvals  write-once human approval of one slot version
--   record_runs            one check of every approved slot: INITIAL, or FOLLOW_UP against an INITIAL baseline
--   record_judgments       MATCHES / CONTRADICTS / UNKNOWN per observation; append-only, superseded
--   record_actions         links an agency action (interventions row) to a slot or the whole record
--   record_shares          opaque public id, ACTIVE then REVOKED, never reactivated
--
-- Every human act names an account member of the client's agency and takes
-- server time. Outcomes are never stored: they are derived at read time.

CREATE OR REPLACE FUNCTION record_member(business UUID, member UUID) RETURNS BOOLEAN AS $$
  SELECT EXISTS (SELECT 1 FROM businesses b JOIN account_users au ON au.account_id = b.account_id
    WHERE b.id = business AND au.user_id = member)
$$ LANGUAGE sql STABLE;

CREATE TABLE IF NOT EXISTS record_profiles (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  website_url TEXT NOT NULL CHECK (website_url ~ '^https?://[^[:space:]]+$'),
  engagement TEXT NOT NULL DEFAULT 'CLIENT' CHECK (engagement IN ('CLIENT','DOGFOOD','FIXTURE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS record_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slot INT NOT NULL CHECK (slot BETWEEN 1 AND 3),
  fact_id UUID NOT NULL,
  question_id UUID NOT NULL,
  source_url TEXT NOT NULL CHECK (source_url ~ '^https?://[^[:space:]]+$'),
  supersedes_id UUID REFERENCES record_items(id),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
-- One root per slot and a linear chain: each version is superseded at most once.
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_items_slot_root ON record_items(business_id, slot) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_items_supersedes ON record_items(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS record_item_approvals (
  item_id UUID PRIMARY KEY,
  business_id UUID NOT NULL,
  approved_by_user_id UUID NOT NULL REFERENCES users(id),
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, business_id) REFERENCES record_items(id, business_id)
);

CREATE TABLE IF NOT EXISTS record_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('INITIAL','FOLLOW_UP')),
  baseline_run_id UUID,
  provider TEXT NOT NULL,
  requested_model TEXT,
  retrieval_required BOOLEAN NOT NULL DEFAULT true,
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  CHECK ((kind = 'INITIAL') = (baseline_run_id IS NULL))
);

CREATE TABLE IF NOT EXISTS record_judgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL,
  item_id UUID NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('MATCHES','CONTRADICTS','UNKNOWN')),
  note TEXT,
  supersedes_id UUID REFERENCES record_judgments(id),
  reviewed_by_user_id UUID NOT NULL REFERENCES users(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
-- One root judgment per observation and a linear correction chain.
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_judgments_root ON record_judgments(observation_id) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_judgments_supersedes ON record_judgments(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS record_actions (
  intervention_id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- NULL: the action concerns the whole record rather than one slot.
  slot INT CHECK (slot IS NULL OR slot BETWEEN 1 AND 3),
  links JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 5),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS record_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- 32 random bytes, base64url without padding (256 bits).
  public_id TEXT NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9_-]{43}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by_user_id UUID REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_shares_active ON record_shares(business_id) WHERE status = 'ACTIVE';

ALTER TABLE check_runs
  ADD COLUMN IF NOT EXISTS record_run_id UUID,
  ADD COLUMN IF NOT EXISTS record_item_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_check_runs_record_item ON check_runs(record_run_id, record_item_id) WHERE record_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_tenant_interventions ON interventions(id, business_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_tenant_judgments ON record_judgments(id, business_id);

-- Composite (id, business_id) references: no record row can point across tenants.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('record_items','fact_id','authoritative_facts'),
    ('record_items','question_id','buyer_questions'),
    ('record_items','supersedes_id','record_items'),
    ('record_runs','baseline_run_id','record_runs'),
    ('record_judgments','observation_id','observations'),
    ('record_judgments','item_id','record_items'),
    ('record_judgments','supersedes_id','record_judgments'),
    ('record_actions','intervention_id','interventions'),
    ('check_runs','record_run_id','record_runs'),
    ('check_runs','record_item_id','record_items')
  ) AS refs(child, col, parent) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_record_' || r.child || '_' || r.col) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I,business_id) REFERENCES %I(id,business_id)',
        r.child, 'fk_record_' || r.child || '_' || r.col, r.col, r.parent);
    END IF;
  END LOOP;
END $$;
ALTER TABLE check_runs DROP CONSTRAINT IF EXISTS check_runs_record_pair;
ALTER TABLE check_runs ADD CONSTRAINT check_runs_record_pair CHECK ((record_run_id IS NULL) = (record_item_id IS NULL));

CREATE OR REPLACE FUNCTION guard_record_item() RETURNS trigger AS $$
BEGIN
  IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'record editor must be an account user'; END IF;
  IF NOT EXISTS (SELECT 1 FROM authoritative_facts f WHERE f.id = NEW.fact_id AND f.business_id = NEW.business_id AND f.status = 'ACTIVE') THEN
    RAISE EXCEPTION 'record items track active facts only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM buyer_questions q WHERE q.id = NEW.question_id AND q.business_id = NEW.business_id AND q.active) THEN
    RAISE EXCEPTION 'record items track active questions only';
  END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM record_items p WHERE p.id = NEW.supersedes_id AND p.business_id = NEW.business_id AND p.slot = NEW.slot
  ) THEN RAISE EXCEPTION 'record item supersedes another slot'; END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_item_guard ON record_items;
CREATE TRIGGER trg_record_item_guard BEFORE INSERT ON record_items FOR EACH ROW EXECUTE FUNCTION guard_record_item();

CREATE OR REPLACE FUNCTION guard_record_approval() RETURNS trigger AS $$
BEGIN
  IF NOT record_member(NEW.business_id, NEW.approved_by_user_id) THEN RAISE EXCEPTION 'approver must be an account user'; END IF;
  NEW.approved_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_approval_guard ON record_item_approvals;
CREATE TRIGGER trg_record_approval_guard BEFORE INSERT ON record_item_approvals FOR EACH ROW EXECUTE FUNCTION guard_record_approval();

CREATE OR REPLACE FUNCTION guard_record_run() RETURNS trigger AS $$
BEGIN
  IF NOT record_member(NEW.business_id, NEW.requested_by_user_id) THEN RAISE EXCEPTION 'run requester must be an account user'; END IF;
  IF NEW.baseline_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM record_runs b WHERE b.id = NEW.baseline_run_id AND b.business_id = NEW.business_id AND b.kind = 'INITIAL'
  ) THEN RAISE EXCEPTION 'follow-up baseline must be an initial run of the same client'; END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_run_guard ON record_runs;
CREATE TRIGGER trg_record_run_guard BEFORE INSERT ON record_runs FOR EACH ROW EXECUTE FUNCTION guard_record_run();

-- A record check asks exactly its slot's question through its run's
-- provider/model, and that binding never changes afterwards.
CREATE OR REPLACE FUNCTION guard_record_check() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.record_run_id, NEW.record_item_id) IS DISTINCT FROM ROW(OLD.record_run_id, OLD.record_item_id) THEN
    RAISE EXCEPTION 'record check binding is immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.record_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM record_runs r JOIN record_items i ON i.id = NEW.record_item_id AND i.business_id = r.business_id
    WHERE r.id = NEW.record_run_id AND r.business_id = NEW.business_id AND i.question_id = NEW.question_id
      AND r.provider = NEW.provider AND r.requested_model IS NOT DISTINCT FROM NEW.requested_model
  ) THEN RAISE EXCEPTION 'record check does not match its run and slot'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_check_guard ON check_runs;
CREATE TRIGGER trg_record_check_guard BEFORE INSERT OR UPDATE ON check_runs FOR EACH ROW EXECUTE FUNCTION guard_record_check();

CREATE OR REPLACE FUNCTION guard_record_judgment() RETURNS trigger AS $$
BEGIN
  IF NOT record_member(NEW.business_id, NEW.reviewed_by_user_id) THEN RAISE EXCEPTION 'reviewer must be an account user'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM observations o JOIN check_runs c ON c.id = o.check_run_id
    WHERE o.id = NEW.observation_id AND o.business_id = NEW.business_id AND c.record_item_id = NEW.item_id
  ) THEN RAISE EXCEPTION 'judgment must review its own slot''s record observation'; END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM record_judgments p WHERE p.id = NEW.supersedes_id AND p.observation_id = NEW.observation_id
  ) THEN RAISE EXCEPTION 'judgment correction must supersede a judgment of the same observation'; END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_judgment_guard ON record_judgments;
CREATE TRIGGER trg_record_judgment_guard BEFORE INSERT ON record_judgments FOR EACH ROW EXECUTE FUNCTION guard_record_judgment();

CREATE OR REPLACE FUNCTION guard_record_action() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM interventions i JOIN businesses b ON b.id = i.business_id
    JOIN account_users au ON au.account_id = b.account_id AND au.user_id::text = i.actor_id
    WHERE i.id = NEW.intervention_id AND i.business_id = NEW.business_id AND i.actor = 'HUMAN') THEN
    RAISE EXCEPTION 'record action must be a human action by an account user';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_action_guard ON record_actions;
CREATE TRIGGER trg_record_action_guard BEFORE INSERT ON record_actions FOR EACH ROW EXECUTE FUNCTION guard_record_action();

-- Only ACTIVE -> REVOKED, by an account user, at server time.
CREATE OR REPLACE FUNCTION guard_record_share() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'record shares are retained'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'shares start ACTIVE and are created by an account user'; END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED'
    OR ROW(NEW.id, NEW.business_id, NEW.public_id, NEW.created_by_user_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.business_id, OLD.public_id, OLD.created_by_user_id, OLD.created_at)
    OR NOT record_member(NEW.business_id, NEW.revoked_by_user_id) THEN
    RAISE EXCEPTION 'a share can only be revoked once, by an account user';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_share_guard ON record_shares;
CREATE TRIGGER trg_record_share_guard BEFORE INSERT OR UPDATE OR DELETE ON record_shares FOR EACH ROW EXECUTE FUNCTION guard_record_share();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['record_items','record_item_approvals','record_runs','record_judgments','record_actions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_record_append ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_record_append BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['record_items','record_item_approvals','record_runs','record_judgments','record_actions','record_shares'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_record_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_record_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation()', t);
  END LOOP;
END $$;

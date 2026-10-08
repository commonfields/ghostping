-- Assay execution and evidence only. Human review is write-once.
CREATE TABLE IF NOT EXISTS assay_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  url TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(trim(subject)) > 0),
  plan_terms JSONB NOT NULL DEFAULT '[]',
  capability_terms JSONB NOT NULL DEFAULT '[]',
  requested_by TEXT NOT NULL CHECK (length(trim(requested_by)) > 0),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','FETCHING','FETCHED','FAILED')),
  claimed_at TIMESTAMPTZ,
  fetched_at TIMESTAMPTZ,
  final_url TEXT,
  raw_evidence_id UUID REFERENCES raw_evidence(id),
  fetched_text TEXT,
  extractor_version TEXT,
  failure_class TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assay_sources_queue ON assay_sources(status, created_at);
ALTER TABLE assay_proposed_facts
  ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES assay_sources(id),
  ADD COLUMN IF NOT EXISTS supporting_span TEXT,
  ADD COLUMN IF NOT EXISTS extractor_version TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_assay_fact_proposal ON assay_proposed_facts(source_id, fact_type, subject, normalized);
CREATE UNIQUE INDEX IF NOT EXISTS uq_assay_sample_number ON check_runs(assay_sample_group_id, sample_number);
ALTER TABLE assay_sample_groups ADD COLUMN IF NOT EXISTS missing_samples JSONB NOT NULL DEFAULT '[]';
ALTER TABLE assay_findings
  ADD COLUMN IF NOT EXISTS requested_n INT,
  ADD COLUMN IF NOT EXISTS unclear_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retrieval_class TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN IF NOT EXISTS verification_eligible BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_diagnosis JSONB NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX IF NOT EXISTS uq_assay_finding ON assay_findings(sample_group_id, proposed_fact_id);
CREATE TABLE IF NOT EXISTS assay_sample_judgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  observation_id UUID NOT NULL REFERENCES observations(id),
  proposed_fact_id UUID NOT NULL REFERENCES assay_proposed_facts(id),
  comparison TEXT NOT NULL CHECK (comparison IN ('MATCHES','CONTRADICTS','NOT_MENTIONED','UNCLEAR')),
  supporting_span TEXT NOT NULL,
  extractor_kind TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  structured_output JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(observation_id, proposed_fact_id)
);

-- Composite references protect both child writes and parent reassignment.
DO $$
DECLARE t TEXT; r RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['buyer_questions','authoritative_facts','observations','assay_sources','assay_proposed_facts','assay_sample_groups','assay_findings'] LOOP
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I(id,business_id)', 'uq_assay_tenant_' || t, t);
  END LOOP;
  FOR r IN SELECT * FROM (VALUES
    ('assay_sample_groups','question_id','buyer_questions'),
    ('check_runs','assay_sample_group_id','assay_sample_groups'),
    ('assay_proposed_facts','source_id','assay_sources'),
    ('assay_sample_judgments','observation_id','observations'),
    ('assay_sample_judgments','proposed_fact_id','assay_proposed_facts'),
    ('assay_findings','sample_group_id','assay_sample_groups'),
    ('assay_findings','proposed_fact_id','assay_proposed_facts'),
    ('assay_finding_reviews','finding_id','assay_findings')
  ) AS refs(child, col, parent) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_assay_' || r.child || '_' || r.col) THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I,business_id) REFERENCES %I(id,business_id)',
        r.child, 'fk_assay_' || r.child || '_' || r.col, r.col, r.parent);
    END IF;
  END LOOP;
END $$;

ALTER TABLE assay_proposed_facts DROP CONSTRAINT IF EXISTS assay_fact_review_complete;
ALTER TABLE assay_proposed_facts ADD CONSTRAINT assay_fact_review_complete CHECK (
  (status = 'PROPOSED' AND reviewed_by IS NULL AND reviewed_at IS NULL AND review_reason IS NULL) OR
  (status <> 'PROPOSED' AND reviewed_by IS NOT NULL AND length(trim(reviewed_by)) > 0
    AND reviewed_at IS NOT NULL AND review_reason IS NOT NULL AND review_reason ~ '[^[:space:]]')
);
ALTER TABLE assay_finding_reviews DROP CONSTRAINT IF EXISTS assay_finding_review_complete;
ALTER TABLE assay_finding_reviews ADD CONSTRAINT assay_finding_review_complete CHECK (length(trim(reviewed_by)) > 0 AND review_reason ~ '[^[:space:]]');
ALTER TABLE assay_sample_groups DROP CONSTRAINT IF EXISTS assay_n_bound;
ALTER TABLE assay_sample_groups ADD CONSTRAINT assay_n_bound CHECK (n BETWEEN 1 AND 20);

CREATE OR REPLACE FUNCTION guard_assay_group() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW)-ARRAY['status','missing_samples']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','missing_samples']) THEN
    RAISE EXCEPTION 'sample group inputs are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assay_group_guard ON assay_sample_groups;
CREATE TRIGGER trg_assay_group_guard BEFORE UPDATE ON assay_sample_groups FOR EACH ROW EXECUTE FUNCTION guard_assay_group();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['assay_sample_judgments','assay_findings','assay_finding_reviews'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_assay_append ON %I',t);
    EXECUTE format('CREATE TRIGGER trg_assay_append BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()',t);
  END LOOP;
END $$;

ALTER TABLE assay_sources ADD COLUMN IF NOT EXISTS claim_token UUID;
CREATE OR REPLACE FUNCTION guard_assay_source() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('FETCHED','FAILED') OR ROW(NEW.id,NEW.business_id,NEW.url,NEW.subject,NEW.plan_terms,NEW.capability_terms,NEW.requested_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.business_id,OLD.url,OLD.subject,OLD.plan_terms,OLD.capability_terms,OLD.requested_by,OLD.created_at) THEN
    RAISE EXCEPTION 'source approval inputs and terminal evidence are immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assay_source_guard ON assay_sources;
CREATE TRIGGER trg_assay_source_guard BEFORE UPDATE ON assay_sources FOR EACH ROW EXECUTE FUNCTION guard_assay_source();

-- Evidence cannot disappear through DELETE or TRUNCATE either.
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['assay_sources','assay_sample_groups'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_assay_delete ON %I',t);
    EXECUTE format('CREATE TRIGGER trg_assay_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['assay_sources','assay_sample_groups','assay_proposed_facts','assay_sample_judgments','assay_findings','assay_finding_reviews'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_assay_truncate ON %I',t);
    EXECUTE format('CREATE TRIGGER trg_assay_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation()',t);
  END LOOP;
END $$;

ALTER TABLE assay_findings DROP CONSTRAINT IF EXISTS assay_finding_counts;
ALTER TABLE assay_findings ADD CONSTRAINT assay_finding_counts CHECK (
  contradict_count > 0 AND unclear_count >= 0 AND unclear_count + contradict_count <= sample_count
  AND (requested_n IS NULL OR requested_n >= sample_count)
);

-- Round 2: retained immutable assay evidence intentionally prevents deletion
-- of a business with assay rows, despite older ON DELETE CASCADE references.
ALTER TABLE assay_proposed_facts ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE assay_proposed_facts ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;
-- NOT VALID preserves legacy uncommitted fixtures without manufacturing
-- provenance; every new/updated row is checked. Legacy facts are not judged.
ALTER TABLE assay_proposed_facts DROP CONSTRAINT IF EXISTS assay_fact_provenance;
ALTER TABLE assay_proposed_facts ADD CONSTRAINT assay_fact_provenance CHECK (
  source_id IS NOT NULL AND supporting_span IS NOT NULL AND length(trim(supporting_span))>0
  AND valid_from IS NOT NULL AND valid_until IS NULL
) NOT VALID;
ALTER TABLE assay_sources DROP CONSTRAINT IF EXISTS assay_source_evidence;
ALTER TABLE assay_sources ADD CONSTRAINT assay_source_evidence CHECK (
  (raw_evidence_id IS NULL) = (fetched_text IS NULL)
  AND (status <> 'FETCHED' OR (raw_evidence_id IS NOT NULL AND fetched_text IS NOT NULL AND fetched_at IS NOT NULL))
) NOT VALID;
CREATE UNIQUE INDEX IF NOT EXISTS uq_assay_source_url ON assay_sources(business_id,url);
CREATE TABLE IF NOT EXISTS assay_fact_retractions (
  fact_id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id),
  retracted_by TEXT NOT NULL,
  retracted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason TEXT NOT NULL CHECK (reason ~ '[^[:space:]]'),
  FOREIGN KEY (fact_id,business_id) REFERENCES assay_proposed_facts(id,business_id)
);
CREATE OR REPLACE FUNCTION guard_assay_retraction() RETURNS trigger AS $$
BEGIN
  -- Serialize withdrawal against new judgments/findings of the same fact.
  PERFORM 1 FROM assay_proposed_facts WHERE id=NEW.fact_id AND business_id=NEW.business_id AND status='CONFIRMED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'only confirmed facts can be retracted'; END IF;
  IF NOT EXISTS (SELECT 1 FROM businesses b JOIN account_users au ON au.account_id=b.account_id
    WHERE b.id=NEW.business_id AND au.user_id::text=NEW.retracted_by) THEN RAISE EXCEPTION 'reviewer must be an account user'; END IF;
  NEW.retracted_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assay_retraction_guard ON assay_fact_retractions;
CREATE TRIGGER trg_assay_retraction_guard BEFORE INSERT ON assay_fact_retractions FOR EACH ROW EXECUTE FUNCTION guard_assay_retraction();
DROP TRIGGER IF EXISTS trg_assay_append ON assay_fact_retractions;
CREATE TRIGGER trg_assay_append BEFORE UPDATE OR DELETE ON assay_fact_retractions FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS trg_assay_truncate ON assay_fact_retractions;
CREATE TRIGGER trg_assay_truncate BEFORE TRUNCATE ON assay_fact_retractions FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation();

CREATE OR REPLACE FUNCTION guard_assay_fact() RETURNS trigger AS $$
DECLARE snapshot TIMESTAMPTZ;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'assay facts are immutable'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'PROPOSED' THEN RAISE EXCEPTION 'facts must start unreviewed'; END IF;
    SELECT fetched_at INTO snapshot FROM assay_sources WHERE id=NEW.source_id AND business_id=NEW.business_id AND status='FETCHED';
    IF snapshot IS NULL THEN RAISE EXCEPTION 'proposal requires a fetched source'; END IF;
    NEW.valid_from := snapshot;
    NEW.valid_until := NULL;
  ELSE
    IF OLD.status <> 'PROPOSED' OR (to_jsonb(NEW)-ARRAY['status','reviewed_by','reviewed_at','review_reason']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['status','reviewed_by','reviewed_at','review_reason']) THEN RAISE EXCEPTION 'assay fact content and completed reviews are immutable'; END IF;
  END IF;
  IF NEW.status <> 'PROPOSED' THEN
    IF NOT EXISTS (SELECT 1 FROM businesses b JOIN account_users au ON au.account_id=b.account_id
      WHERE b.id=NEW.business_id AND au.user_id::text=NEW.reviewed_by) THEN RAISE EXCEPTION 'reviewer must be an account user'; END IF;
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assay_fact_guard ON assay_proposed_facts;
CREATE TRIGGER trg_assay_fact_guard BEFORE INSERT OR UPDATE OR DELETE ON assay_proposed_facts FOR EACH ROW EXECUTE FUNCTION guard_assay_fact();
CREATE OR REPLACE FUNCTION guard_assay_review() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses b JOIN account_users au ON au.account_id=b.account_id
    WHERE b.id=NEW.business_id AND au.user_id::text=NEW.reviewed_by) THEN RAISE EXCEPTION 'reviewer must be an account user'; END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assay_review_guard ON assay_finding_reviews;
CREATE TRIGGER trg_assay_review_guard BEFORE INSERT ON assay_finding_reviews FOR EACH ROW EXECUTE FUNCTION guard_assay_review();
ALTER TABLE assay_sample_judgments DROP CONSTRAINT IF EXISTS assay_judgment_span;
ALTER TABLE assay_sample_judgments ADD CONSTRAINT assay_judgment_span CHECK (length(supporting_span)>0) NOT VALID;
CREATE OR REPLACE FUNCTION guard_assay_judgment() RETURNS trigger AS $$
DECLARE snapshot TIMESTAMPTZ;
BEGIN
  SELECT valid_from INTO snapshot FROM assay_proposed_facts f WHERE f.id=NEW.proposed_fact_id AND f.business_id=NEW.business_id AND f.status='CONFIRMED' FOR UPDATE;
  IF snapshot IS NULL OR EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=NEW.proposed_fact_id) THEN RAISE EXCEPTION 'judgments require active confirmed snapshot facts'; END IF;
  IF NOT EXISTS (SELECT 1 FROM observations o WHERE o.id=NEW.observation_id AND o.business_id=NEW.business_id
    AND o.collected_at >= snapshot AND length(NEW.supporting_span)>0 AND position(NEW.supporting_span in o.answer_text)>0) THEN
    RAISE EXCEPTION 'judgment requires exact nonempty span after snapshot'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assay_judgment_guard ON assay_sample_judgments;
CREATE TRIGGER trg_assay_judgment_guard BEFORE INSERT OR UPDATE ON assay_sample_judgments FOR EACH ROW EXECUTE FUNCTION guard_assay_judgment();
CREATE OR REPLACE FUNCTION guard_assay_sample() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.assay_sample_group_id IS NOT NULL THEN RAISE EXCEPTION 'assay samples cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.assay_sample_group_id IS NOT NULL AND
    ROW(NEW.assay_sample_group_id,NEW.sample_number,NEW.business_id,NEW.question_id,NEW.provider,NEW.requested_model) IS DISTINCT FROM
    ROW(OLD.assay_sample_group_id,OLD.sample_number,OLD.business_id,OLD.question_id,OLD.provider,OLD.requested_model) THEN RAISE EXCEPTION 'sample identity is immutable'; END IF;
  IF (NEW.assay_sample_group_id IS NULL) <> (NEW.sample_number IS NULL) THEN RAISE EXCEPTION 'sample number requires group'; END IF;
  IF NEW.assay_sample_group_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM assay_sample_groups g WHERE g.id=NEW.assay_sample_group_id AND g.business_id=NEW.business_id
      AND g.question_id=NEW.question_id AND g.provider=NEW.provider AND g.requested_model IS NOT DISTINCT FROM NEW.requested_model
      AND NEW.sample_number BETWEEN 1 AND g.n) THEN RAISE EXCEPTION 'sample does not match group'; END IF;
    IF NEW.status='SUCCEEDED' AND NOT EXISTS (SELECT 1 FROM observations WHERE check_run_id=NEW.id AND business_id=NEW.business_id) THEN RAISE EXCEPTION 'successful assay sample requires observation'; END IF;
    -- A finished sample is evidence: it cannot be re-opened or relabelled.
    IF TG_OP='UPDATE' AND OLD.status IN ('SUCCEEDED','FAILED') AND NEW.status IS DISTINCT FROM OLD.status THEN RAISE EXCEPTION 'finished assay samples are immutable'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assay_sample_guard ON check_runs;
CREATE TRIGGER trg_assay_sample_guard BEFORE INSERT OR UPDATE OR DELETE ON check_runs FOR EACH ROW EXECUTE FUNCTION guard_assay_sample();
ALTER TABLE assay_findings DROP CONSTRAINT IF EXISTS assay_finding_retrieval;
ALTER TABLE assay_findings ADD CONSTRAINT assay_finding_retrieval CHECK (
  retrieval_class IN ('RETRIEVAL_ENABLED','STALE_PARAMETRIC_KNOWLEDGE','MANUAL_CAPTURE','UNKNOWN','SYNTHETIC_FIXTURE')
  AND verification_eligible=(retrieval_class='RETRIEVAL_ENABLED')
);
CREATE OR REPLACE FUNCTION guard_assay_finding() RETURNS trigger AS $$
DECLARE p assay_proposed_facts; g assay_sample_groups; total INT; contradictions INT; unclear INT; eligible BOOL; rc TEXT; v TEXT;
BEGIN
  SELECT * INTO p FROM assay_proposed_facts WHERE id=NEW.proposed_fact_id AND business_id=NEW.business_id FOR UPDATE;
  IF NOT FOUND OR p.status<>'CONFIRMED' OR p.valid_from IS NULL OR EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=p.id) THEN RAISE EXCEPTION 'finding requires active confirmed fact'; END IF;
  IF EXISTS (SELECT 1 FROM assay_proposed_facts c WHERE c.business_id=p.business_id AND c.fact_type=p.fact_type AND lower(trim(c.subject))=lower(trim(p.subject)) AND c.normalized=p.normalized AND c.status='CONFIRMED' AND NOT EXISTS (SELECT 1 FROM assay_fact_retractions WHERE fact_id=c.id) AND ROW(c.reviewed_at,c.id)<ROW(p.reviewed_at,p.id)) THEN RAISE EXCEPTION 'finding requires canonical fact'; END IF;
  SELECT * INTO g FROM assay_sample_groups WHERE id=NEW.sample_group_id AND business_id=NEW.business_id;
  IF NOT FOUND OR g.status NOT IN ('SUCCEEDED','PARTIALLY_SUCCEEDED') THEN RAISE EXCEPTION 'finding requires terminal same-business group'; END IF;
  SELECT count(*)::int,count(*) FILTER (WHERE j.comparison='CONTRADICTS')::int,count(*) FILTER (WHERE j.comparison='UNCLEAR')::int,
    CASE WHEN bool_or(o.synthetic) THEN 'SYNTHETIC_FIXTURE'
      WHEN bool_and(o.retrieval_mode IN ('WEB_SEARCH','PROVIDER_GROUNDING','grounded')) THEN 'RETRIEVAL_ENABLED'
      WHEN bool_and(o.retrieval_mode IN ('NONE','parametric')) THEN 'STALE_PARAMETRIC_KNOWLEDGE'
      WHEN bool_and(o.retrieval_mode='MANUAL_CAPTURE') THEN 'MANUAL_CAPTURE' ELSE 'UNKNOWN' END
    INTO total,contradictions,unclear,rc
    FROM assay_sample_judgments j JOIN observations o ON o.id=j.observation_id JOIN check_runs r ON r.id=o.check_run_id
    WHERE j.proposed_fact_id=p.id AND j.business_id=NEW.business_id AND r.assay_sample_group_id=g.id AND r.status='SUCCEEDED' AND o.collected_at>=p.valid_from;
  IF total<>(SELECT count(*) FROM check_runs r JOIN observations o ON o.check_run_id=r.id WHERE r.assay_sample_group_id=g.id AND r.status='SUCCEEDED' AND o.collected_at>=p.valid_from)
    OR total=0 OR contradictions=0 THEN RAISE EXCEPTION 'finding requires complete compared samples'; END IF;
  eligible := rc='RETRIEVAL_ENABLED';
  v := CASE WHEN contradictions>=3 AND contradictions::numeric/total>=0.6 THEN 'CONFIRMED'
    WHEN contradictions>=2 AND contradictions::numeric/total>=0.4 THEN 'OBSERVED_INTERMITTENT' ELSE 'ANECDOTAL' END;
  IF ROW(NEW.sample_count,NEW.requested_n,NEW.contradict_count,NEW.unclear_count,NEW.verdict,NEW.retrieval_class,NEW.verification_eligible)
    IS DISTINCT FROM ROW(total,g.n,contradictions,unclear,v,rc,eligible) THEN RAISE EXCEPTION 'finding counts and classification do not match evidence'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_assay_finding_guard ON assay_findings;
CREATE TRIGGER trg_assay_finding_guard BEFORE INSERT ON assay_findings FOR EACH ROW EXECUTE FUNCTION guard_assay_finding();
-- Dead 0019 columns: nothing reads or writes them (promotion into
-- authoritative_facts and a free-text likely source were superseded by
-- source_diagnosis). The history view selects f.*, so it is rebuilt.
DROP VIEW IF EXISTS assay_finding_history;
ALTER TABLE assay_proposed_facts DROP COLUMN IF EXISTS promoted_fact_id;
ALTER TABLE assay_findings DROP COLUMN IF EXISTS likely_source;
-- Historical reads must explicitly flag withdrawn truth; the queue filters it.
CREATE VIEW assay_finding_history AS SELECT f.*, EXISTS (SELECT 1 FROM assay_fact_retractions r WHERE r.fact_id=f.proposed_fact_id) AS fact_retracted FROM assay_findings f;

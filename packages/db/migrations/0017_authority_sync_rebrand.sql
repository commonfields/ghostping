-- SEARCH_OPERATOR_V1-era rebrand: move the manifest-sync setting from
-- ghostping.authority_sync to openrecord.authority_sync.
-- 0005_truth_projection_v1.sql is left untouched (applied-migration
-- immutability); redefining the function here is the forward-safe path.
-- Old databases pick this up on the next migrate run; fresh databases get
-- the new name from the start. The hosted API only ever sets the new name.

CREATE OR REPLACE FUNCTION check_fact_authority() RETURNS trigger AS $$
DECLARE
  mode TEXT;
  sync_flag TEXT;
BEGIN
  SELECT writer INTO mode FROM business_authority_mode WHERE business_id = NEW.business_id;
  IF mode = 'REPOSITORY_MANIFEST' THEN
    BEGIN
      sync_flag := current_setting('openrecord.authority_sync', true);
    EXCEPTION WHEN OTHERS THEN
      sync_flag := NULL;
    END;
    IF sync_flag IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'fact of business % is managed by repository manifest', NEW.business_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

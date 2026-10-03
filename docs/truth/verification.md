# Verification Bridge

Projection `verify` blocks compile to existing SourceTarget/SourceBinding
descriptors and sync idempotently (canonical-URL match; no duplicates;
bindings track logical fact lineage, never copied values). Collection,
extraction, comparison, and IN_SYNC/DRIFT/UNKNOWN stay in the
Representation Graph. After the owner's normal deployment, live
observation may show LIVE_SOURCE_IN_SYNC ("the live controlled source
now matches the approved fact") — never "our write caused the
deployment" without deployment evidence.

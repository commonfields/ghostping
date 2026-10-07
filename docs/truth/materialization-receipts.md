# Materialization Receipts (`openrecord/materialization-receipt-v1`)

Immutable local-write evidence: projection, output, CREATED/UPDATED/
UNCHANGED action, before digest (KNOWN/NOT_APPLICABLE/UNKNOWN),
after digest, source refs, manifest digest, compiler version,
timestamp, actor. Stored append-only under `.openrecord/receipts/`
(exclusive-create; corrections are new records). A receipt claims a
local write and NOTHING about publication, indexing, retrieval, or AI
impact — those fields do not exist.

Lineage honesty: source refs are either MANIFEST_FACT (offline: proves
the manifest key and manifest digest only) or AUTHORITATIVE_FACT
(post-sync: the real fact UUID and version). Offline compilation never
invents a database identity; synced compilation preserves the true
version (v2 stays v2). Projection bytes never depend on UUIDs.

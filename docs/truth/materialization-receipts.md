# Materialization Receipts (`ghostping/materialization-receipt-v1`)

Immutable local-write evidence: projection, output, CREATED/UPDATED/
UNCHANGED action, before digest (KNOWN/NOT_APPLICABLE/UNKNOWN),
after digest, source fact versions, manifest digest, compiler version,
timestamp, actor. Stored append-only under `.ghostping/receipts/`
(exclusive-create; corrections are new records). A receipt claims a
local write and NOTHING about publication, indexing, retrieval, or AI
impact — those fields do not exist.

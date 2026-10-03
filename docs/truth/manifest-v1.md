# Truth Manifest V1 (`ghostping/truth-manifest-v1`)

`ghostping.yaml` is versioned, fail-closed desired state. Fact types:
text (raw Unicode string), boolean (`true|false`), money
(`{amount: decimal string, currency: AAA}` — decimal, never binary float;
currency explicit, never inferred from locale/TLD/page).

Rejects: unknown schema/fields, duplicate keys, dangling refs, bad types,
malformed timestamps (canonicalized to millis instants), bad money or
currency, unsafe output paths, `${...}` interpolation anywhere, YAML
tags/anchors/aliases, non-`repository` authority mode. Manifest digest =
SHA-256 over canonical JSON of the normalized manifest. Source revision is
operator-supplied (`--revision`) or absent — never fabricated from git.

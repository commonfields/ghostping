# Projections (JSON_LD only)

Typed AST: literals plus `{fact, component}` references (text/boolean →
`value`; money → `amount|currency`). Compiler resolves refs against
canonical facts into canonical JSON bytes + SHA-256
(`truth-compiler/1`, `application/ld+json`). No timestamps, randomness,
paths, network, or interpolation. Same manifest + fact versions +
compiler = same bytes, always.

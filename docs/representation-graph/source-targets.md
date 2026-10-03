# Source Targets & Bindings

SourceTarget: exactly one configured URL Ghostping may observe (OWNED /
THIRD_PARTY / UNKNOWN, enabled flag). Not a crawl seed.

SourceBinding: fact → target + deterministic extractor (JSON_LD / CSS_TEXT /
META_CONTENT with explicit selector/path) + comparator (EXACT_TEXT / BOOLEAN /
MONEY). Bindings never duplicate the expected value; authority lives in
AuthoritativeFact only.

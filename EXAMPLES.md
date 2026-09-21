# Ghostping Examples

Real-world before/after use cases showing how Ghostping helps improve AI visibility.

---

## Example 1: Rust CLI Tool

**Project:** A new Rust CLI tool for file searching
**Niche:** "Rust CLI tool for developers"

### Before (initial audit)
```
Mention rate: 8% (1/12 queries)
Models: openai
```

The tool wasn't mentioned when users asked about file search tools.

### Ghostping Optimization
```bash
ghostping optimize mytool.com --niche "Rust CLI tool" --competitors "ripgrep,fd" --auto-apply
```

Generated content:
- `geo/best-rust-cli-tools.md` — "Top 10 Rust CLI tools in 2024"
- `geo/fast-file-search-rust.md` — "Why Rust is great for file search performance"

### After (re-audit)
```
Mention rate: 42% (5/12 queries)
Projected citability: +34pp
```

---

## Example 2: Indie SaaS Product

**Project:** A URL shortener for developers
**Niche:** "Developer tools, URL shortening"

### Before
```
Mention rate: 0% (0/8 queries)
```

### Optimization
Generated optimized content for queries like:
- "best URL shortener for developers"
- "self-hosted URL shortener"

### After
```
Mention rate: 25% (2/8 queries)
```
Still room for improvement — iterating on more content.

---

## Example 3: Open Source Library

**Project:** A Python data processing library
**Niche:** "Python data processing"

### Before
```
Mention rate: 17% (2/12 queries)
```

### Generated Content
- `geo/python-data-processing.md`
- `geo/fast-data-transformations-python.md`

### After
```
Mention rate: 33% (4/12 queries)
```

---

## Example 4: Personal Brand

**Project:** Indie hacker building in public
**Niche:** "Indie hacker, SaaS bootstrapping"

### Before
```
Mention rate: 0% (0/8 queries)
```

### Generated Content
- `geo/bootstrapped-saas-success-stories.md`
- `geo/build-in-public-tips.md`

### After
```
Mention rate: 25% (2/8 queries)
```

---

## Tips for Better Results

1. **Be specific with niches** — "Rust CLI tool for data engineers" beats "Rust tool"
2. **Add competitors** — helps Ghostping benchmark against known players
3. **Run audits regularly** — model behavior changes over time
4. **Write quality content** — Ghostping generates drafts; polish them before committing
5. **Use --evaluate** — see before/after citability estimates before writing files

---

## Caveats

- Ghostping improves *probability*, not guarantee
- Results vary by niche competitiveness
- Some models may never cite certain topics
- Success requires ongoing iteration
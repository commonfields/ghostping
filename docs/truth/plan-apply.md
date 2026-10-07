# Plan / Apply

Plan: CREATE (no file), UPDATE (managed bytes differ), UNCHANGED (managed
proof + bytes match), CONFLICT (unmanaged or hand-edited; identical bytes
without proof also CONFLICT), STALE_MANAGED_ARTIFACT (removed projection;
never auto-deleted). Never PUBLISHED/DELIVERED/INDEXED. No `--force`.

Apply writes only declared outputs + `.openrecord/` metadata. Guards:
relative paths only, no `..`, no absolute, no `.git`, symlink components
rejected at write time, atomic temp-sibling + fsync + rename. Lock file
`.openrecord/projections.lock.json` holds derived state only (id/output/
digest/compiler) — never fact values, never authority.

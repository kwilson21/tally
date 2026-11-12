# Where these rules came from

- Source: https://github.com/dmmulroy/anti-slop (MIT, see `LICENSE`)
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13)
- Copied from: `skills/install-anti-slop/assets/anti-slop/` (the same files as upstream `src/`, without its tests)
- Installed at: `tools/oxlint/anti-slop/`, registered in `oxlint.config.ts`
- Changes made here: none. `effect/` is copied but not registered (decision 191).
- Upstream tests against Oxlint 1.78.0; Tally pins `oxlint` and `@oxlint/plugins` at 1.93.0 (decision 201).

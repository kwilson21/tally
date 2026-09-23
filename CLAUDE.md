# Tally

A family budgeting app on Cloudflare Workers, with a public demo at demo.thesuperhuman.us.

## Source of truth
- Spec: docs/superpowers/specs/2026-09-22-tally-design.md. If it isn't in the spec, don't build it; add it to the spec's Later list and ask.
- Decisions: docs/decisions.md. Never reverse a decision silently; propose a new entry.
- Tasks: GitHub Issues, one milestone per phase. ROADMAP.md links to them.
- Design system: DESIGN.md. UI must use its tokens and components; update it in the same PR when adding either.

## Rules
- Every part must be explainable in one plain sentence. If you can't explain it that way, don't add it.
- Prefer the smallest tool. No new dependency without a decision entry.
- Server owns all state. Hono JSX + HTMX. No client-side framework. Only custom JS: Plaid Link and the toast listener.
- Money is integer cents. Never floats. Format to dollars only for display.
- Plaid sign convention: positive = money out. Dates are Plaid's YYYY-MM-DD strings; no time-zone math.
- AI suggests, code calculates, people decide. Jev only via src/ai/categorize.ts; Workers AI only via src/ai/suggest-name.ts.
- Call Plaid and Jev with plain fetch; no SDKs. One Jev call per transaction (category + all flags together).
- Identity: read the user from the verified Cloudflare Access JWT (Cf-Access-Jwt-Assertion), never the plain Cf-Access-Authenticated-User-Email header.
- The demo environment never gets Plaid secrets or production bindings.
- Secrets only via `wrangler secret put` (owner runs it). Never commit .dev.vars. Never log tokens or transaction details.
- HTMX feedback: HX-Trigger header with `toast` + `announce` keys.
- Accessibility: labeled forms, focus-visible rings, 44px touch targets, aria-live on swap regions, role="alert" for errors.

## Before writing code
- Check current docs (Context7 or official docs) for any API you use. Never write from memory.
- TDD: failing test first. Most tests cover pure money logic; route tests use the Workers runtime; E2E only for critical flows.
- Tests: import env and exports from "cloudflare:workers" (not the deprecated cloudflare:test exports).

## Commands
- npm run dev / npm test / npm run typecheck / npm run lint / npm run format
- Deploy (owner-approved only): npx wrangler deploy --env <demo|production>

## Pull requests
- `main` only accepts PRs; required checks: `check` (CI) and `Greptile Review`.
- UI PRs: CI adds screenshots (1280×800 and 390×844) to the description; check them before asking for review. The owner merges after looking. Non-UI PRs may auto-merge.
- If Greptile hasn't reported within 30 minutes or errors: run `/code-review` (high) plus an independent reviewer agent, post findings as a PR comment titled "Fallback review (Greptile unavailable)", fix and re-review. Only the owner merges such a PR; never use a ruleset bypass.

## Git
Conventional commits (feat:, fix:, refactor:, test:, docs:, chore:, ci:). One issue per PR; "Closes #N" in the PR body.

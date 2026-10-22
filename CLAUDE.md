# Tally

A family budgeting app on Cloudflare Workers, with a public demo at tally-demo.thesuperhuman.us.

## Source of truth
- Spec: docs/superpowers/specs/2026-09-22-tally-design.md. If it isn't in the spec, don't build it; add it to the spec's Later list and ask.
- Decisions: docs/decisions.md. Never reverse a decision silently; propose a new entry.
- Tasks: GitHub Issues, one milestone per phase. ROADMAP.md links to them.
- Design system: DESIGN.md and its catalog at /design-system (demo and dev only). UI must use its tokens and components; update both in the same PR when adding either.

## Rules
- Every part must be explainable in one plain sentence. If you can't explain it that way, don't add it.
- Prefer the smallest tool. No new dependency without a decision entry.
- Server owns all state. Hono JSX + HTMX. No client-side framework. Only custom JS: Plaid Link, the toast listener, the money input's money.js (decision 39), the catalog-only ds.js (decision 44), the feedback form's feedback-privacy.js and feedback-diagnostics.js (decision 61), and keyboard.js and the sheet script sheet.js (decision 109), and the push notification's push.js and its service worker sw.js, and the check-in's home-seen.js (decision 149).
- Money is integer cents. Never floats. Format to dollars only for display.
- Plaid sign convention: positive = money out. Dates are Plaid's YYYY-MM-DD strings, never converted; only "today" uses the household's time zone (decision 67).
- AI suggests, code calculates, people decide. Jev only via src/ai/categorize.ts; Workers AI only via src/ai/suggest-name.ts (names) and src/ai/read-receipt.ts (Clairic and toMarkdown, decision 137), and the never-deployed scripts/compare-models/ Worker that measures Clef against Jev (decision 136).
- Call Plaid and Jev with plain fetch; no SDKs. One Jev call per transaction (category + all flags together), and one per receipt for its items' categories (decision 137).
- Identity: read the user from the verified Cloudflare Access JWT (Cf-Access-Jwt-Assertion), never the plain Cf-Access-Authenticated-User-Email header.
- The demo environment never gets Plaid secrets or production bindings.
- Secrets only via `wrangler secret put` (owner runs it). Never commit .dev.vars. Never log tokens or transaction details.
- HTMX feedback: HX-Trigger header with `toast` + `announce` keys.
- Accessibility: labeled forms, focus-visible rings, 44px touch targets, every HTMX swap announced (an aria-live count or announcer, or moving focus; never a live list), role="alert" for errors.

## Before writing code
- UI work starts in the catalog (DESIGN.md "Process for a UI change"): the component at its tier, the owner's sign-off there, then the app page.
- Check current docs (Context7 or official docs) for any API you use. Never write from memory.
- TDD: failing test first. Most tests cover pure money logic; route tests use the Workers runtime; E2E only for critical flows.
- Tests: import env and exports from "cloudflare:workers" (not the deprecated cloudflare:test exports).

## Commands
- npm run dev / npm test / npm run typecheck / npm run lint / npm run format
- Deploy (owner-approved only): `npx wrangler deploy --env <demo|production> --message "<vYYYY.MM.DD or demo> <short sha>" --var "APP_VERSION:<vYYYY.MM.DD or demo> <short sha>"`; a production deploy is also a dated release (README "Versions and releases", decision 98)

## Pull requests
- `main` only accepts PRs; required check: `check` (CI). The independent review is Codex's code review and security review through its GitHub connector (decision 102; Greptile's trial ended on Oct 11).
- UI PRs: CI adds a before-and-after table to the description with only the pages the PR adds or changes, at 1280×800 and 390×844 (decision 141); check them and send the owner the pages that changed. Claude merges a PR itself once it's complete (decision 51; see the next bullet): CI green, Codex's code and security reviews reported on its head commit with every finding answered, and its look and decisions already the owner's (signed off in the catalog or picked on the proposals page). The owner verifies the finished pages from those screenshots after the merge (DESIGN.md step 6); a change they want is a follow-up or a revert. New visual choices, spec changes and reversing a decision go to the owner first.
- Review rounds, for EVERY PR (UI or not, decision 96): after three rounds of review fixes (a round is a push that answers the review bots' findings), a finding that could lose or miscount money or data, break a keyboard or screen-reader path, expose something private or show wrong words is still fixed before the merge. Every other finding is answered on the PR in one plain sentence, filed as a follow-up issue labelled `review-followup` (linking the PR and the comment), and the PR merges once `check` is green and Codex's code and security reviews have both reported on its head commit, even if they are not clean. This replaces "every finding answered" in the merge rule above for the leftover non-critical findings.
- Work split (decisions 51, 52, 71, 78, 88, 97, 129): Claude subagents running Haiku 5.5 build each issue from the main session's brief (tests first), in its own git worktree on the owner's machine, and commit; they never push or open a PR. Each brief ends with a Confidence block, and a brief with three or more tasks, a UI feature, a change to src/routes/transactions.tsx, a money, category or matching rule, or more than one plausible approach first gets one read-only brief check (decision 129). A fresh Haiku 5.5 subagent verifies it (every command CI's `check` job runs: `npm ci` first when the PR changes `package.json` or `package-lock.json`, in its own worktree rather than through the shared `node_modules` link; then `npm test`, `npm run test:feedback-integration`, typecheck, lint, the build and both Wrangler deploy dry-runs; plus the e2e and the scope). The e2e needs a migrated app running first, as `.github/workflows/screenshots.yml` does: `npm run db:migrate:local`, then `npx wrangler dev --port 8787` in the background until `/healthz` answers, then `npm run e2e` (it resets the demo data itself; another port works with `BASE_URL`; `npm ci` doesn't install its browser, so run `npx playwright install chromium` once, as `screenshots.yml` does, or set `CHROMIUM_PATH` to a local Chrome); its findings, and any code change a PR review asks for, go back to a builder subagent and then a fresh verifier before the next push. The main session delivers: it pushes the branch only if its head commit is the one the fresh subagent verified, opens the PR, confirms with `git ls-remote` and an open-PR check that both exist, answers every Codex review comment (Codex's PR reviews are the independent review, decision 102; after a fix push, comment `@codex review` and `@codex security review`, since Codex reviews on its own only when a PR opens), checks any changed page in a browser, and owns getting the PR merged. If the subagents keep failing, stop and tell the owner. Design and product decisions stay in the main session. Grok is for research only, mainly news on X; it never writes or verifies code and is sent no secrets or transaction data. A separate Claude Code session runs ultracode workflows for the design and polish tracks only. Before decision 97, Codex built and a fresh Codex run verified (decision 88); before that Claude Sonnet subagents built the issues (decision 78), and before that Codex cloud opened its own PRs (decision 52).
- If Codex hasn't reviewed the head commit within 30 minutes or errors: comment `@codex review` and `@codex security review` once more; if it still hasn't, run an independent reviewer agent, post its findings as a PR comment titled "Fallback review (Codex unavailable)", fix and re-review. Only the owner merges such a PR, except while Codex is out of credits (decision 107): then Claude also runs a code and a security review itself and merges under the usual rule. Never use a ruleset bypass.

## Git
Conventional commits (feat:, fix:, refactor:, test:, docs:, chore:, ci:). One issue per PR; "Closes #N" in the PR body.

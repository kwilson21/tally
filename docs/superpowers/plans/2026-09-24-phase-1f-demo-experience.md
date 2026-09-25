# Phase 1f (Demo experience) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the live demo explain itself (#13). One pull request with:
1. **Things to try:** a short block at the top of Home, in the demo only. Each item links to the exact place to do it.
2. **How Tally works** (`/how-it-works`, demo only):
   - the system diagram as inline SVG
   - one plain sentence per part (spec §4)
   - one section per shipped feature. Each gives its one-sentence explanation, its rule in plain words, and a worked example built from the demo's own live numbers.
3. **"How this works" links** from each screen to its section.

The demo banner already exists (`src/views/layout.tsx`, with spec §8's exact text: "Demo data. Nothing here is real."). This plan only checks it and leaves it as is.

**Scope, from the owner's comment on #13:** Phase 1 ships the architecture section, plus sections for:
- feature 1 (budget and safe to spend)
- feature 3 (transactions)
- categorization

Later phases add their sections with their features (bills, splits, exclusions, trends, balances, documents). Every screen that has a section links to it.

**Architecture:** server-rendered, like the rest of the app. `GET /how-it-works` loads the current month with the same `loadMonth` and `summarizeMonth` that Home uses. So the worked example's numbers are Home's numbers by construction, not copied text. The Things to try block is a view component that Home renders when `DEMO === "true"`. Neither needs any JavaScript.

**Tech stack:** Hono JSX, the Tailwind v4 tokens, and the existing components (`Layout`, `Icon`, `Band`). The diagram is hand-written SVG in a view file, using the design tokens (`stroke-ink`, `fill-paper`, `text-muted`) the way `illustration.tsx` does. There are no new dependencies.

**Spec:** §3 (features and demo scope), §4 (the one-sentence parts table), §6 (money rules), §7 (category priority), §8 (the Demo only row and accessibility), §9 (the How it works structure; its text must match the spec's rules). **Direction:** round 3 studies `home-desktop-illustrated-ledger-v1.webp` (Things to try) and `how-it-works-desktop-illustrated-ledger-v1.webp` (layout). **Issue:** #13.

**Out of scope, with where each part goes:**
- Sections for features 2, 4, 5, 6, 7 and 8: each ships with its feature (Phases 3 and 4).
- A "Change a budget amount" item (in the study): Settings isn't built yet. It's added with budget editing.

---

## Owner review: choices this plan makes

1. **Demo only.** Spec §8 lists the banner, Things to try and How it works under "Demo only". So `/how-it-works` returns 404 when `DEMO` isn't `"true"`, and the Things to try block and "How this works" links render only in the demo. Production can get the page later if you want it; that would be a spec change.
2. **Things to try has three items**, all doable in the demo today:
   - **Give a transaction a category** → `/transactions?uncategorized=1`
   - **Set a rule for a merchant** → the Local Bakery edit sheet (`/transactions/110?uncategorized=1`). The item's text says to tick "Always use this category for this merchant". A seed test already pins id 110 to Local Bakery.
   - **Rename a merchant** → the same sheet. Its text points at the merchant name field.

   Plus a "How Tally works →" link. The study's third item, "Change a budget amount", waits for Settings.
3. **No close (×) button.** Closing it for good needs saved state: a cookie or a table, plus a form post. The block is three lines in a demo that resets nightly, so it just stays. If you want the ×, it's a cookie set by a small POST, and it goes on the Later list.
4. **The worked examples use live numbers.** For example: "This month: $2,450 budget − $1,166 spent = $1,284 safe to spend." They're computed on each request from the same functions as Home, so they're always right, even after a visitor's edits.
   - **Bills** (Phase 3) aren't in the demo yet. The example says so in words instead of showing "− $0 for bills due": "Bills due this week are also set aside; the demo adds bills in a later phase." The rule text still states the full spec §6 rule.
5. **The diagram** follows the study:
   - Your bank (via Plaid) → Tally server (Cloudflare Worker) ↔ Database (D1)
   - The server calls Jev (picks categories) and Workers AI (suggests names)

   Below it is the full spec §4 parts table, one sentence each, word for word. The SVG has `role="img"`, a `<title>` and a `<desc>`, and the table after it is the text version. A line under the diagram says the demo has no bank connection and runs on a fictional household that resets every night.
6. **"How this works" link placement:** a small muted link under each page's title:
   - Home → `#budget`
   - Transactions → `#transactions`
   - the edit sheet → `#categorization`

   Placeholder pages (Bills, Trends, and so on) get no link until their sections exist. The More page lists "How Tally works" in the demo.

---

## File structure

| File | Change |
|---|---|
| `src/views/things-to-try.tsx` | New: `ThingsToTry` (demo only; rendered by Home) |
| `src/views/how-link.tsx` | New: `HowLink({ section })`, the small "How this works" link. Renders nothing outside the demo. |
| `src/views/system-diagram.tsx` | New: the inline SVG diagram |
| `src/routes/how-it-works.tsx` | New: `GET /how-it-works` (404 outside the demo) |
| `src/how-it-works/examples.ts` | New, pure: builds each worked-example sentence from a `MonthSummary` and counts, with `formatCents` |
| `src/routes/home.tsx`, `src/routes/transactions.tsx`, `src/routes/destinations.tsx` | Render `ThingsToTry`, `HowLink`, and the More list item |
| `src/index.tsx` | Mount the route |
| `scripts/pr-body.mjs` | Add `/how-it-works` to the screenshot pages |
| `DESIGN.md` | Add ThingsToTry, HowLink, SystemDiagram, and the "explainer page" pattern |
| spec §9 | Record choices 2, 3 and 6 (the three items, no dismiss, link placement) |
| tests | Listed per task |

---

### Task 0: Branch and spec

- [ ] Branch from `main`. Add to spec §9: the three Things to try items and where they link, that there's no dismiss (with the ×-by-cookie idea added to §12 Later), that the page is demo-only, and where the "How this works" links go.

### Task 1: Worked examples (pure, tested first)

- [ ] `test/how-examples.test.ts`, written first, against fixed `MonthSummary` inputs:
  - `budgetExample(summary)` returns the three amounts as formatted strings, and budget − spent = safe to spend holds in cents. It uses `formatCents` with whole dollars, like Home's headline.
  - An over-budget category produces the "over" sentence.
  - `transactionsExample({ counted, needsCategory })` gives "This month has 125 counted transactions; 12 need a category". Singular and plural are both covered.
  - `categorizationExample({ user, merchantRule, jev, unsure })` names only the sources with a nonzero count. For example: "This month Jev picked 8 categories on its own and left 4 it wasn't sure about for a person." With `jev: 0`, there's no Jev sentence. Jev is live since #12, and the threshold, 80%, is shown from `JEV_THRESHOLD`.
- [ ] Implement `src/how-it-works/examples.ts`. The functions return plain strings; the view adds the markup.

### Task 2: Counts query (route-runtime test first)

- [ ] `test/how-counts.test.ts` runs against the seed and checks the counts for the current month:
  - counted transactions
  - needs category (it must equal `needsCategoryCount`, which Home uses)
  - how many categories were chosen by a person, by a merchant rule, and by Jev
- [ ] Add `categorySourceCounts(db, month)` to `src/db/transactions.ts`, reusing the "counted" definition already there.

### Task 3: Views (tests first, with `jsx()` in `.ts` files)

- [ ] `test/things-to-try.test.ts`:
  - The three links go to the right hrefs, plus the How Tally works link.
  - It's a `<section>` with a heading.
  - Each link is at least 44px tall (`min-h-11`).
- [ ] `test/system-diagram.test.ts`: the SVG has `role="img"`, a `<title>` and a `<desc>`, and every box label text.
- [ ] `test/how-link.test.ts`: the link renders only with `demo: true`, and its href is `/how-it-works#<section>`.
- [ ] Build the views from the design tokens:
  - Things to try is a bordered block, as in the study, with accent links.
  - The diagram uses `stroke-width` 1.75, like the illustration.

### Task 4: The page and the links (route tests first)

- [ ] `test/how-it-works-route.test.ts`:
  - The demo gets 200, with sections `#architecture`, `#budget`, `#transactions` and `#categorization`.
  - The budget example's safe-to-spend amount equals the one Home shows (fetch both pages, compare).
  - With `DEMO` set to `"false"`, the page is a 404, and Home has neither Things to try nor a "How this works" link.
- [ ] Update the existing Home and Transactions route tests:
  - Home has Things to try and a link to `#budget`.
  - Transactions links to `#transactions`, and the edit sheet to `#categorization`.
  - More lists How Tally works in the demo.
- [ ] Build `src/routes/how-it-works.tsx`, laid out as in the study: a serif title, a one-paragraph intro, the diagram, the parts table, then the feature sections.
  - Each section has an `h2` with an `id`, and its rule in a short list.
  - The page ends with the tally-mark glyph.
- [ ] Wire `HowLink` into Home, Transactions and the edit sheet. Add the More item.

### Task 5: Docs, checks, PR

- [ ] Update DESIGN.md with the three components and the explainer-page pattern. Add `/how-it-works` to `PAGES` in `scripts/pr-body.mjs`.
- [ ] Run `npm run build && npm run typecheck && npm run lint && npm test`, `npm run e2e` (the recategorize flow still passes with the block above it), and `npm run screenshots` (no console errors).
- [ ] In Chromium at 390×844 and 1280×800, check:
  - the block's links wrap cleanly on a phone
  - the diagram scales to the phone width without horizontal scroll (`viewBox`, `w-full`)
  - Tab order reaches the block's links before the month
  - the focus rings show
- [ ] Open the PR with "Closes #13". It's a UI PR, so the owner merges it after checking the screenshots. Then redeploy the demo (`npx wrangler deploy --env demo`).

---

## Risks

| Risk | Guard |
|---|---|
| The page's text drifts from the spec's rules | The rules are quoted from spec §6 and §7. The spec says a rule change updates this page in the same PR; DESIGN.md's explainer pattern repeats that. |
| The example numbers disagree with Home | They're computed with the same functions, and a route test compares the two pages. |
| The diagram overflows on a phone | `viewBox` with `w-full h-auto`, checked at 390px in the screenshots. |
| Links into the edit sheet break when the seed changes | The seed test pins id 110 to Local Bakery; Things to try uses only that id. |

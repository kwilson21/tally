# Design brief: Tally learns from your answers (draft for the owner's approval)

Status: proposal. Nothing here is built. It changes the spec and needs new decision entries, so the owner approves first
(CLAUDE.md: new visual choices, spec changes and reversing a decision go to the owner first).

## The idea in one sentence

When you answer a Maybe, Tally remembers what you chose, offers a new category when none fits, and then quickly re-checks only the rows that could now fit, without making you wait.

## What the data says today (production, 2026-11-02)

- No transaction is marked `user` or `merchant_rule`. 135 categorized rows are Jev's guesses, 9 are linked to bills, 108 have no category (57 merchants). Confirmed answers are close to zero, so there is little to learn from yet.
- Bank text is messy: dates, state codes, reference IDs and "POS DEBIT" prefixes ("APPLE.COM/BILL CA 09/30", "Kindle Unltd*TE3E10I7 WA 07/26"). Raw text would put almost every row in a group of one.
- The merchant name and the bank text differ: the card says "Amazon", the bank text is "Audible" (3 rows). A merchant key would group all of Amazon together, which is wrong.
- Entertainment is mostly APPLE.COM/BILL (vague: App Store, iCloud, Music, Books), Netflix, and a scatter of others. The small clusters (Audible and Kindle, about 3 rows; museums, about 4 rows) are too small for automatic detection to be worth building now.

## Scope: three parts (build in this order)

### 1. "Something else" can pick or create a category

- Today: "Maybe Entertainment" has Yes, Something else, Skip.
- New: Something else keeps opening in place; its category chips become a dropdown, plus one "New category: <name>" suggestion row when Jev has a reasonable name (it uses the existing none-fit naming path, `src/ai/suggest-name.ts`). Exact layout is in the Layout bullet below.
- Picking New creates the category (50-category limit applies, decision 37; at the limit it offers "Add to an existing category" instead of failing).
- Budget (owner's pick, 2026-11-02): a new category is added with no amount. Its spending counts as unbudgeted spending, the old category's budget is unchanged, and no prompt appears.
- Layout (owner's picks, 2026-11-02): no new screen; three answers on the same card, in this order. (1) The existing "Yes, <guess>" button. (2) One dashed row "New category: <name>" labeled "Tally's suggestion", shown only when Jev has a reasonable name. (3) The existing Something else disclosure (`SomethingElse` in `src/views/suggestion-review.tsx:411`), whose category chips become the design system's one select ("Choose a category"), then the existing "Save and next". The Maybe tag and guess line stay above all three. No "fits an existing category" section and no save-on-selection.
- Tapping the suggestion row (owner's pick): it opens in place, as Something else does, with the name pre-filled and editable and a "Create and next" button. Nothing is created until that button; then the category is created with no amount, the card's transaction is filed in it, and the re-sort starts.
- Catalog: the select-for-chips swap and the dashed row are new visual choices, so draw them at the component's tier in the catalog and get the owner's sign-off there before the app page.
- Design first: draw this list in the catalog (DESIGN.md "Process for a UI change") with the Audible screen as the example.

### 2. The re-sort (two steps, no waiting)

Step A, instant, no AI: after a category is created, find other transactions with the same **cleaned bank text** and show them as a card with each row pre-ticked: "2 more look like this. Add to Books & audio". Nothing moves until the person taps. This is the existing new-category card (decision 120) with a pre-filled tick list.

- The group key is the cleaned bank text: strip dates (MM/DD), state codes, reference IDs and "POS DEBIT"-style prefixes. Never the merchant name alone, and never for a store Jev marks as mixed (decision 90).
- A known-vague line (APPLE.COM/BILL) groups only together with the "what it was" note when one exists; with no note it is not grouped.

Step B, background, Jev: re-ask only rows that could plausibly fit, front of the person's queue first.

- Candidates: uncategorized or Maybe rows (never one the person confirmed; never one at 80% or more) that share the Plaid category of the moved rows, or whose current guess is the category the moved rows came from.
- Order: the next cards in the person's review queue first, then the rest of the candidates.
- Rows outside the candidates are not re-asked now; they get the new category in Jev's list the next time they are sorted normally. A missed fit stays a Maybe: one tap, nothing lands in the wrong category.
- Jev's answer is applied only at high confidence; below that it becomes a Maybe. A person's own answer made while the re-sort runs always wins (reuse `src/db/sorting-turn.ts`).
- Where rows share a cleaned bank text, ask once for the group and apply the answer to the rest (needs a decision entry, see below). Rows that differ in a way that matters (a very different amount, a mixed trip) fall back to one call each.
- Overlapping re-sorts merge into one run.

Progress and feedback (real-time feel, built as polling):

- The "Tally is re-sorting" line appears in the same response as the category's creation, shows "Sorting… 12 of 15", and stays on the review screen, Transactions and Home until done.
- HTMX polls every 1 to 2 seconds only while a re-sort runs. Count announced politely, not on every tick, rows never a live list (accessibility rule).
- Moved rows get a brief highlight. The review count and next card reflect results as they arrive.
- A closing toast: "Moved 14 to Books & audio. 3 need your answer", with Undo. Undo reverses only the rows that action moved, so each re-sort records which rows it moved.
- Websockets were considered and not proposed: Tally has none, they need a Durable Object binding and new state, and the visible difference is about a second. Build the progress endpoint so a push channel could use it later. If the owner prefers websockets, that becomes its own decision.

### 3. "What Tally has learned" page (Settings)

- One line per learned choice, keyed by cleaned bank text: "Audible → Books & audio". Each line has **Forget** and **Change**; Change makes the new choice a merchant rule (rules already outrank AI guesses).
- Built from the person's confirmed choices only (`user`, `merchant_rule`). Jev's guesses never count as evidence. It starts nearly empty on production and fills as the queue is answered.
- Jev receives only the lines relevant to the transaction, replacing the five-trip `merchantCategoryHistory` (`src/ai/categorize.ts:26`). Capped list, newest answers weigh more.
- Approved in chat 2026-11-02: the page is named "What Tally has learned" and sits beside "Tally's rules" in Settings (the builder confirms how Settings is organized). Each row shows "bank text → category" and "From N of your answers", with Change (opens in place with the select, the note "From now on Audible goes here every time.", and Save) and Forget (toast with Undo for 10 seconds). Empty state: "Nothing yet". Jev gets only the line for the transaction's own cleaned bank text. Two data details were not drawn and must be checked first: Forget needs a memory (lines are derived), and a rule cannot be keyed by the merchant (Amazon is not Audible).
- Later: show which charges a learned line has affected.

## Later (add to the spec's Later list, do not build now)

- Automatic "this category is a grab bag, split out X" detection. Trigger to revisit: enough confirmed answers per category (suggested 8 or more, across 3 or more distinct cleaned-text groups).
- Offering "always use X for Y?" after repeated picks, if it beats a learned line.

## Decisions to propose (owner approves; numbers assigned at merge, check main and open PRs first)

1. Learned preferences: store cleaned bank text and the chosen category from the person's confirmed answers, shown and editable at Settings. Widens decision 155, which deliberately kept no merchant or name. Spell out the exact fields kept.
2. A new category triggers a re-sort of related rows (extends decision 89, which suggests only from "none fit"). Candidates rule, ordering, and the high-confidence-only application.
3. Grouped Jev calls for a re-sort only: one call per group of identical cleaned bank text. Amends the one-call-per-transaction rule (decisions 103 and 137); normal sorting is unchanged.
4. HTMX polling for the re-sort's progress (a new pattern). Websockets listed as considered, not needed.

## Builder tasks (each tests first; each brief ends with a Confidence block)

1. `cleanBankText(raw)`: pure function with tests from the real strings above (Apple dates, "POS DEBIT", Kindle reference ID, Museum rows, Audible). Confidence: 8, the strings are real; the rule set is assumed.
2. Group matcher: same cleaned text, never merchant-only, never mixed, vague lines only with a note. Confidence: 7, vague-line list is assumed.
3. Re-sort candidate selection and ordering (pure, tested). Confidence: 6, assumes `plaid_category` is stored on most rows; builder first measures how many production-like rows have it.
4. Re-sort run: reuse the existing sort path and `sorting-turn.ts`; confirm a new category counts as a change that allows a re-ask despite decision 143's never-pay-twice rule. Confidence: 5, unchecked, the first thing the builder verifies.
5. Moved-rows record and Undo. Confidence: 6.
6. Progress line, poll endpoint and toast, after the catalog sign-off. Confidence: 6.
7. Something else list and create flow, after the catalog sign-off. Confidence: 7.
8. Learned page and Jev context lines, after the catalog sign-off. Confidence: 5, needs decision 1 settled.

Counter-argument to check: the filter could miss real fits and the group call could mislabel a row inside a group. Both fail safe (a Maybe, not a wrong category), but the builder should confirm that with a test.

Not yet checked: how many production rows carry `plaid_category` (Apple Card uploads may not); whether Amazon rows other than Audible exist on production (the earlier query's join may not match the app's merchant key); the Entertainment list was cut at 25 groups.

## Open questions for the owner

Settled in chat: new category added with no amount; polling first, no websockets; Option A (simplified) for the list.

1. Approve the four decision entries and the spec changes above.
2. Approve drawing the two new screens in the catalog (the Something else list, then the learned page), which a builder does from this brief.

# Design studies

Generated studies are composition references only. They are not screenshots of the product and not a spec for how anything behaves. The real UI is built in HTML from the design system, and the numbers in a study are placeholders; code does the math. Generation prompts and rejected source images stay in the owner's private archive.

## Selected direction: "Quiet ledger" (2026-09-22)

The owner chose Direction A out of three studies (A "Quiet ledger," B "Soft utility," C "One big number").

- Home, mobile: [home-mobile-quiet-ledger-v1.webp](2026-09-22/home-mobile-quiet-ledger-v1.webp)

What the direction is:
- Warm paper background, ink text, hairline dividers instead of cards or shadows. It shares its foundations with thesuperhuman.us.
- The headline amount uses an editorial serif (Newsreader); everything else uses Inter with tabular numerals.
- Progress bars have two states: green when on track, brick red when over budget, always paired with an icon and a word.
- Terracotta (`#AE5534`) is used only for navigation and links. It is never a status color.

Decisions made while reviewing:
- The owner's own edit: green and red bars instead of the single accent.
- The avatar circles in the header are dropped. The spec has no feature for them.
- No "close to the limit" state. A nearly full green bar already shows it; a third state adds a color to explain.
- The exact green is picked during token work, with at least 3:1 contrast against the paper background (WCAG 1.4.11).

Rejected: B "Soft utility" and C "One big number."

## Round 2: Phase 1 screens in Quiet ledger (2026-09-22)

- Home, desktop: [home-desktop-v1.webp](2026-09-22/home-desktop-v1.webp)
- Transactions, mobile: [transactions-mobile-v1.webp](2026-09-22/transactions-mobile-v1.webp)
- Transaction edit panel, mobile: [transaction-edit-mobile-v1.webp](2026-09-22/transaction-edit-mobile-v1.webp)
- How Tally works, desktop: [how-it-works-desktop-v1.webp](2026-09-22/how-it-works-desktop-v1.webp). Layout only; the real diagram is built as SVG.

Owner review: the proportions and hierarchy are right, but the result feels "visually boring and sterile." A character pass (round 3) explores adding warmth and a signature without losing glanceability. Still missing: the Home "Things to try" variant.

## Round 3: character pass (2026-09-22)

Selected: Variant 3, "Illustrated ledger," with Things to try: [home-desktop-illustrated-ledger-v1.webp](2026-09-22/home-desktop-illustrated-ledger-v1.webp). Rejected: Variant 1 "Warm ledger" and Variant 2 "Bento ledger."

What this round adds on top of Quiet ledger:
- A tally-mark glyph as the brand signature, in the wordmark and as a notch at each budget limit.
- Serif (Newsreader) for the month and section titles.
- A small line icon for each category.
- One line illustration next to the headline amount (notebook, pencil, tally marks).
- An italic serif status sentence written by code from the numbers.
- A tinted band behind the one action that matters ("N transactions need a category").
- The "Things to try" block for the demo.

Proposed corrections to the image (pending owner confirmation):
- Category colors must not use status hues (green or red). Use dusty blue, plum, ochre, slate, and warm brown.
- Each category gets an icon in its color, not a dot plus an icon.
- The navy text is drift. Secondary text goes back to muted gray.
- The illustration will be redrawn as SVG using the icon stroke rules. Generated art doesn't ship.

## Round 4: Phase 1 screens in Illustrated ledger (2026-09-22)

The owner accepted all four studies:
- Home, mobile: [home-mobile-illustrated-ledger-v1.webp](2026-09-22/home-mobile-illustrated-ledger-v1.webp)
- Transactions, mobile: [transactions-mobile-illustrated-ledger-v1.webp](2026-09-22/transactions-mobile-illustrated-ledger-v1.webp)
- Transaction edit panel, mobile (category chips instead of a dropdown): [transaction-edit-mobile-illustrated-ledger-v1.webp](2026-09-22/transaction-edit-mobile-illustrated-ledger-v1.webp)
- How Tally works, desktop: [how-it-works-desktop-illustrated-ledger-v1.webp](2026-09-22/how-it-works-desktop-illustrated-ledger-v1.webp)

The corrections from round 3 are confirmed: category colors avoid status hues, each category has one icon (no dot), and secondary text is gray. Build notes:
- The illustration's green strokes become ink with a terracotta pencil, since green is reserved for status.
- Excluded rows get a muted transfer icon, not the dashed "needs category" slot.
- The owner asked for a "How X works" section for every feature (spec §9).

## Round 5 brief: Settings and Accounts (Phase 2, decision 35)

The owner generates these. Make each screen in the Illustrated ledger direction at 390×844 (mobile) and 1280×800 (desktop), with the same paper, ink, rules, type, icons and category colors as round 4. Use the Rivera household's names and plausible numbers; code does the math.

- **Settings** (More → Settings; spec §7, §8). One page, three sections:
  - **Categories:**
    - Each row shows its icon in its category color, its name, and this month's budget (or "No budget").
    - Actions: "Add category", rename, reorder, archive (the word is "Archive", never "Delete"), and set a budget "from <month> on".
    - Show one row being edited: a name field and a budget field, with a field error under the name ("That name is taken").
  - **Merchant names** (built in Phase 4): one suggested name, such as "SQ *FARMERS MKT" → "Farmers Market", with Accept and Reject.
  - **Suggested categories** (built in Phase 4): one suggestion, such as "Pets", with the three transactions behind it, and Create and Dismiss.
- **Accounts** (More → Accounts; spec §8):
  - Net worth as the headline number. Leave room for the net-worth chart that comes in Phase 4.
  - Accounts grouped by bank: checking, savings and a credit card, with their balances. Debt shows as negative.
  - One bank connection that needs attention, with "Fix connection" and a word plus an icon for its status (status is never color alone).
  - A "Link a bank" button.

Save the selected images in `docs/design-concepts/<date>/` and record the selection here, as for rounds 2–4.

## Round 5: Settings and Accounts (2026-09-25)

The owner generated these without the reference image attached, and accepted all four as layout guides:
- Settings, mobile: [settings-mobile-v1.webp](2026-09-25/settings-mobile-v1.webp)
- Settings, desktop: [settings-desktop-v1.webp](2026-09-25/settings-desktop-v1.webp)
- Accounts, mobile: [accounts-mobile-v1.webp](2026-09-25/accounts-mobile-v1.webp)
- Accounts, desktop: [accounts-desktop-v1.webp](2026-09-25/accounts-desktop-v1.webp)

**What to take from them:**
- **Settings:** categories as a list with icon, name and "$600 a month". One row opens in place to edit its name and "Budget from <month> on". On desktop the name and budget fields sit side by side. The error uses an icon and words. "Archive" is a link, never a delete button. "+ Add category" and "Archived (1)" sit under the list. Merchant names and suggested categories (Phase 4) sit below, each with a primary and an outline button.
- **Accounts:** net worth as the serif headline, with a ruled space for the Phase 4 chart. Accounts are grouped by bank, with debt shown negative. A connection that needs attention shows an alert icon and words, plus "Fix connection". "Link a bank" is the primary button.

**Build notes: where the studies drifted, the design system wins.**
- The demo banner, wordmark, navigation and nav icons come from the built Layout, Sidebar and BottomTabs. The studies moved the banner under the wordmark, left it off the desktop Settings study, and drew different nav icons.
- Row names, field labels and bank names use the sans (Inter), never the serif. Some desktop labels drifted into the serif, and so did the "Link a bank" button text.
- Bank group names use the muted small sans, not uppercase with letter spacing, which isn't in DESIGN.md.
- "+ Add category" has no chevron and is terracotta like a link. As built (#55) it opens the add form in place, like the other rows.
- Account rows keep a line icon on both sizes. The desktop Accounts study dropped them.

## Build checks

- 2026-09-22, Phase 1a shell (branch `phase-1a-design-system`): checked in a browser at 1280×800 and 390×844. Inter and Newsreader load from our own origin; the demo banner, sidebar (desktop), bottom tabs (mobile), and tally-mark wordmark render; Home is marked current in terracotta. The console is clean with no CSP violations, and the toast and announce listeners work. Screenshots were shared with the owner in the review conversation. They weren't committed, to avoid adding a screenshot toolchain for one check.
- 2026-09-23, Phase 1c-1 Home (#9): checked with the CI screenshot script at 1280×800 and 390×844 on the seeded demo. Matches the round 4 Home studies (month, Safe to spend with the ledger illustration, status sentence, category band, budget bars with limit notch, over-budget word and icon), minus Things to try (#13) and Due soon (Phase 3). The Uncategorized row is added per spec §6.

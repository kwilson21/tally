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

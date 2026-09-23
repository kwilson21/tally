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

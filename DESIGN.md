# Tally design system

Direction: "Illustrated ledger" (docs/design-concepts/README.md). Calm, warm, glanceable in under 3 seconds. A well-kept paper ledger with a little personality.

## Design language (#79)

### The brief (owner, 2026-09-26)
> Tally should feel like a breath of fresh air to people who have tried budgeting apps but felt they were too hard to use or could not commit to using it consistently.

> The tell is a finished but lazily done project. Finishing an idea is half the battle; you have to do the work to have something of value at the end.

So every screen is judged by two questions: **would someone who gave up on budgeting apps come back to this tomorrow**, and **what would a careful designer have done here that we skipped?** "It renders" is not done. Every state, edge case and word is part of the work, and the test is day 30, not day 1.

Every screen and component is designed in three layers, in this order.

### 1. Scenery: what sets the feeling
The elements people don't consciously notice. Together they make Tally feel light, warm and in control, the opposite of a bank statement. Each one has a job and a limit.

| Element | Its job | It must never |
|---|---|---|
| Paper (`paper`, `band`) | Warmth; the page feels like a notebook, not a form | Turn into cards, boxes or panels that make the page feel busy |
| Rules and space | Separate things quietly; one column, one measure per screen | Vary in width from block to block, or leave leftover gaps that look unplanned |
| Type | Newsreader for the one thing that matters; Inter for everything else | Put two serif headlines of similar size on one screen |
| Illustration and the tally mark | Personality, once per screen at most | Crowd the number it sits beside, or appear as decoration everywhere |
| Category icons and colors | Recognition at a glance | Carry meaning about status (that's green/brick only) |
| Bars | Show how much of a budget is used | Paint the page; a column of saturated bars is louder than the words it supports |
| Voice | Plain, second person, calm; numbers first, then what they mean ("$120 left") | Shout (capitals, exclamation marks), blame ("you failed"), or use bank jargon (raw merchant strings, "debit", "posted") |
| Motion | Confirms that something happened (a bar fills, a row is highlighted) | Decorate, bounce, or delay; reduced motion always shows the end state |

### 2. Signage: what directs attention
What a person should see first, second and third, and the one thing to do. Signs are few; each one is earned.

- **First:** the one thing the screen is for (Home: how much is safe to spend and for how long; Transactions: the list; a sheet: the choice being made). It gets the serif, the size or the band. Nothing else on the screen uses the same size.
- **Second:** what it means, in a sentence (the status sentence, the result count).
- **Third:** the one next action (the Band, or a sheet's primary button). One primary action per screen or sheet.
- **Everything else is quieter.** Secondary actions are outline buttons; tertiary ones (Archive, Move, "How this works") are terracotta text, placed where they're found, never beside the primary.
- **A sign appears once.** If a count, a tag or a link already says it, don't repeat it on every row.
- **Demo aids** (the banner, Things to try, How this works) help a visitor, but never push the one thing out of the first screen on a phone.

### 3. Use: how each interactive part behaves
Every interactive component has a written spec, shown next to it in the catalog. The spec answers:

1. **Purpose:** one sentence, in the person's words.
2. **Affordance:** how it shows it can be used, without hovering (touch has no hover).
3. **States:** rest, hover, focus, pressed, disabled, loading, done, error; which ones apply, and what each looks like.
4. **Feedback:** what happens after each action, where the eye goes next, and what's announced.
5. **Input:** touch (44px targets, gestures if any), keyboard (Tab order, keys), screen reader (name, role, state).
6. **Motion:** what moves, for how long, and the reduced-motion version.
7. **Edge cases:** empty, zero, one, very long text, very large numbers, slow network, no JavaScript.
8. **Words:** every label, error and confirmation, written out.

A component isn't ready for sign-off until every line is answered or marked "not applicable" with a reason.

## Principles
1. One thing matters per screen. It gets the serif, the size, or the band. Nothing else competes.
2. Status is never color alone. Every red or green state also has an icon and a word.
3. Categories and status never share a hue. Status: green/brick. Categories: blue, plum, slate, ochre, brown.
4. Terracotta means "you can click this." Links, link-styled actions (Archive, Restore, Add category) and the current nav item only.
5. Explainable in one sentence. If a component can't be, it doesn't exist.

## Tokens (src/styles/app.css @theme)
| Token | Hex | Use | Contrast on paper |
|---|---|---|---|
| paper | #FBF8F2 | page background | — |
| band | #EFEBE3 | the one highlighted row; demo banner | — |
| ink | #0E0E0E | text | 18.2 |
| muted | #4A4A4A | secondary text | 8.4 |
| rule | #E8E3DA | dividers, empty bar track | decorative |
| accent | #AE5534 | links, current nav (never on band: 4.26) | 4.8 |
| ok | #2F7A4F | on-track bar | 4.9 |
| over | #A93226 | over budget / overdue bar, icon, word | 6.3 |
| cat-blue / plum / slate / ochre / brown | #3F6C9A / #7A4A7E / #4F6272 / #A87414 / #7A5230 | category icons only | 5.2 / 6.4 / 6.0 / 3.8 / 6.4 |

Radii: `rounded-control` (0.75rem) for inputs, chips, buttons; `rounded-sheet` (1.25rem) for the bottom sheet top corners. No shadows except toasts.

## Type roles
| Role | Style |
|---|---|
| Page title / month | font-serif, 5xl, semibold, tight tracking |
| Section title | font-serif, 3xl, semibold |
| Headline amount | font-serif, 6xl–7xl, semibold, tabular |
| Sheet title and amount | font-serif, 4xl, semibold (the edit panel's name and amount) |
| Status sentence | font-serif italic, lg |
| Body / rows | font-sans (Inter), base–lg, tabular numerals |
| Secondary | font-sans, text-muted |

## Components (src/views/)
| Component | One sentence |
|---|---|
| Wordmark, TallyMark | The tally-mark glyph plus serif "Tally"; the brand. |
| Icon | Lucide line icons, 1.75 stroke, currentColor, always aria-hidden. |
| Sidebar / BottomTabs | The same destinations: a sidebar on desktop, four tabs plus More on phones. |
| Layout | Every page's shell: banner, navigation, main, toast and announce regions. |
| CategoryIcon | A category's line icon, drawn in its color token. |
| ProgressRow | One category: icon, name, "spent of budget," and a 4px bar with no limit marker (decision 46); over budget, the bar is full and brick, with an alert icon and how much it's over in words ("$36 over"). In Adjust mode (#94) it adds a round − before the row and a round + after it, each a form that moves the budget to the next round $10; on a phone − takes the icon's place, and its bar redraws without replaying the fill. When the name and amount don't fit on one line, the amount moves under the name, breaking at "of" if it must, never inside a number. |
| AdjustLink | "Adjust" beside Home's Budget heading, a terracotta text link that shows − and + on every budgeted row; in Adjust mode it says "Done". |
| Band | The one tinted row per screen that links to the thing to do next. |
| LedgerIllustration | The notebook-and-pencil line drawing beside the headline; ink plus a terracotta pencil. |
| TransactionRow | One transaction as a single link to its edit panel: icon, name, category or status in words, signed amount. |
| Chip | A pill-shaped checkbox or radio (optionally with an icon); the real input is visually hidden but keyboard-reachable. A checkbox chip is a toggle and shows a check mark while on, so its state isn't color alone. |
| FormField | A labeled control, with its error shown in `role="alert"`. |
| BottomSheet | A page region over the list (bottom sheet on phones, right-hand panel on desktop) with a dimmed backdrop; not a modal, closed by Cancel or the backdrop. |
| ThingsToTry | The demo's bordered "New here? Things to try" block at the top of Home: three links to where each thing is done, plus How Tally works. |
| HowLink | A small "How this works" link under a screen's title to its section of How Tally works; renders nothing outside the demo. |
| MoneyInput | The owner's hero amount from the original app (#66), in Tally's tokens: a round −$1 button (48px), a 292px amount field (`$`, the amount in bold 1.75rem, always with cents: "700.00") with ▲▼ cent arrows stacked inside its right edge behind a hairline (each 44×44: the field is 90px tall so the stacked arrows meet the touch-target rule, decision 41), and a round +$1 button. Under it, centered chips: "Round to $X" (only with cents) and "Last month: $X" (dimmed when the field already holds it). Minus buttons are disabled at $0. In the field, ↑ / ↓ change the amount by 1¢ (Shift: $1), as the original's number field did. money.js runs it; without it the buttons and chips are hidden. |
| SystemDiagram | The inline SVG diagram of Tally's parts on How Tally works; scales to the screen width, with a title and description for screen readers. |
| BudgetDiagram, TransactionsDiagram, ExclusionsDiagram, CategoriesDiagram | How Tally works' section diagrams (#61), drawn from the same numbers as each worked example: boxes and arrows for Budget, Transactions and Categories; one bar for Excluding. Ink, muted and rule only, plus ok (or over) on the safe-to-spend box, always with its words. A dashed outline means "not counted" or "not decided yet". |

## Patterns
- Feedback after an HTMX change: `HX-Trigger: {"toast": {"message", "type"}, "announce": "..."}`.
- Who picked a category: when Jev picked it, a muted `text-sm` line under the category chips says "Picked by Jev · N% sure". A person's choice and a merchant rule show nothing extra.
- Edits: the form saves, the list swaps back with the toast and announcement, and focus returns to the row (or to the result count if the row left a filtered list). Without JavaScript the save redirects back to the list.
- Result count: the `aria-live` line above a list names every active filter ("12 transactions needing a category in September", "Showing 1–25 of 35 transactions in Groceries, September"), so any filter change changes its text and is announced.
- Edit panel layout (owner's pick C, #27): the category chips first; then two toggle chips, "Always for this merchant" and "Exclude from budget"; then "Rename or add a note" behind a disclosure, which opens itself when there's a note or an error. An excluded transaction says "Excluded from the budget" with the transfer icon under the date. One "How this works" link.
- Disclosure: `<details>` with a `<summary>` row (44px) led by a chevron that turns when open (`group-open:rotate-90`); no JavaScript.
- Home budget rows (#66): each row is a link to its budget sheet (a BottomSheet over Home, like the edit panel), with a screen-reader-only ", change the budget". Categories with no budget sit under a small muted "Not budgeted" heading, each ending in a terracotta "Add a budget". Adjust mode (#94, decision 48) is specified in the catalog, next to its specimen, with all eight parts of its use spec.
- Settings list (round 5 studies, #55): each category is a disclosure row (icon, name, "$600 a month" with "a month" muted, chevron at the far right) that opens in place to rename. Its budget is changed on Home (decision 38), through a "Change its budget on Home" link in the open row. Save and Cancel sit on one line with Archive, a terracotta text button, at the far right; Move up and Move down, outline buttons, sit below. "+ Add category" is a terracotta disclosure row; "Archived (n)" lists archived categories with Restore.
- Extra actions in a form (Archive, Move): a second submit button with `formaction` and its own `hx-post`, so it works without JavaScript and never needs a form inside a form. Anything the action needs goes in its URL (`…/move/up`), because htmx doesn't send which button was pressed.
- Excluded rows in a list show a muted transfer icon and the word "Excluded" (never color alone).
- Sheet backdrop: `bg-ink/30` (ink at 30%), used only behind the BottomSheet; it is decorative, so no contrast target.
- Explainer page (How Tally works): each section is a serif h2 with an `id` the HowLinks point to, the rule in a short list quoted from the spec, and a worked example in a band-tinted box ("In the demo: …") computed by code from live numbers. When a rule changes in the spec, its section changes in the same PR.
- Illustrations: SVG, drawn with the icon stroke rules, ink plus one accent. Generated images never ship.
- Money: integer cents in the database and in code; format only in views with `formatCents` (src/money.ts).
- Motion: budget bars fill on load (CSS). `prefers-reduced-motion` shows the final state. No count-up: it would need custom JavaScript.
- Bars are inline SVG. The CSP forbids style attributes, and SVG width attributes aren't CSS.

## Catalog (decisions 42–44)
`/design-system` shows every component in its states. It exists in the demo and in development; production returns 404. The inventory of the original app's components, and what Tally keeps, is in docs/design-system/inventory.md.

Principles, from the original app's integrity protocol:
- **No broken windows.** If something looks clickable in the catalog, it works. If it can't work there, it doesn't look clickable.
- **No fake interactivity.** Nothing in the catalog pretends to talk to the server. If a component needs the server, it's Visual in the catalog and works in a Flow.
- **The real component, never a copy.** The catalog imports the component from `src/views/` and passes it typed fake data, so it can't drift from the app. UI that is still assembled inside a route (for example the Transactions filters or Home's headline and status sentence) is extracted into `src/views/` first, in the PR that catalogs it; the catalog never copies its markup.
- **The catalog doesn't make its own bugs.** A catalog-only bug that costs time and fixes nothing in the app means the process failed.

Every component has exactly one tier, shown as a pill:
| Tier | Rule | Where |
|---|---|---|
| Visual | Static states side by side. The wrapper has `hx-ignore` (htmx 4's name for making a subtree inert) and the catalog's CSP has `form-action 'none'`, so nothing can post. | Catalog sections |
| Interactive | Works in the browser without the server: CSS, `<details>`, money.js, toast.js, and the catalog's own controls in `ds.js`. | Catalog sections |
| Flow | A multi-step journey on fake data. The step is in the URL (`?step=2`), and each step renders the real components. | Its own page under `/design-system/flows/` |

`ds.js` only runs catalog controls (fire a sample toast, replay an animation). It never intercepts or fakes a request, and app pages never load it.

Where it lives: `src/routes/design-system.tsx` (the pages and their gate), `src/design-system/catalog.tsx` (the specimens), `mock.ts` (typed fake data) and `tokens.ts` (the color and type tables). Tests keep it honest: every component in the table above must appear in the catalog, every Visual specimen carries `hx-ignore`, the catalog's colors must match `app.css`, and `test/design-tokens.test.ts` fails on colors, radii or shadows outside the tokens. Its exceptions are listed in the test with their reasons: the toast's `shadow-sm`, and the money input's original corners, which are reviewed with the owner in the MoneyInput PR.

## Process for a UI change (decision 43)
1. **Design in the catalog.** Build or change the component there, at its tier, with fake data. A new screen starts with a generated study first (decisions 21, 35); a component starts here.
2. **Audit** against this file: the design language's three layers (scenery, signage, and a complete use spec for anything interactive), then tokens only, type roles, 44px targets, focus-visible rings, status never color alone, and every swap announced.
3. **Screenshots** of the catalog at 1280 and 390, and the owner checks the catalog in a browser and signs off. CI screenshots only the pages listed in `PAGES` in `scripts/pr-body.mjs`, so every catalog and flow page is added there in the PR that adds it.
4. **Use it in the app.** The app imports the same component, so there's nothing to copy.
5. **E2E** for the critical flows.
6. **The owner verifies** the app pages.

**Visual decisions are made by seeing, not by reading.** Every proposal that changes how something looks is shown in the catalog as current and proposed, side by side, at 1280 and 390, before the owner decides. A decision entry is written only after that, and each accepted proposal ships in its own PR, so undoing it is one revert.

A backend-only change skips step 1.

## Governance
- A new screen's visual direction starts as a generated study, gets owner selection, and is recorded in docs/design-concepts/README.md. Its components then go through the catalog.
- A new token or component updates this file and the catalog in the same PR, with its contrast value if it's a color.
- Accessibility: 44px targets, focus-visible ring, labeled forms, every HTMX swap announced through an aria-live count or announcer, or by moving focus (never a live list).

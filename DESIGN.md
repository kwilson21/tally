# Tally design system

Direction: "Illustrated ledger" (docs/design-concepts/README.md). Calm, warm, glanceable in under 3 seconds. A well-kept paper ledger with a little personality.

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
| ProgressRow | One category: icon, name, "spent of budget," and an SVG bar with a notch at the limit; over budget adds an alert icon and the words "over budget." |
| Band | The one tinted row per screen that links to the thing to do next. |
| LedgerIllustration | The notebook-and-pencil line drawing beside the headline; ink plus a terracotta pencil. |
| TransactionRow | One transaction as a single link to its edit panel: icon, name, category or status in words, signed amount. |
| Chip | A pill-shaped checkbox or radio (optionally with an icon); the real input is visually hidden but keyboard-reachable. A checkbox chip is a toggle and shows a check mark while on, so its state isn't color alone. |
| FormField | A labeled control, with its error shown in `role="alert"`. |
| BottomSheet | A page region over the list (bottom sheet on phones, right-hand panel on desktop) with a dimmed backdrop; not a modal, closed by Cancel or the backdrop. |
| ThingsToTry | The demo's bordered "New here? Things to try" block at the top of Home: three links to where each thing is done, plus How Tally works. |
| HowLink | A small "How this works" link under a screen's title to its section of How Tally works; renders nothing outside the demo. |
| SystemDiagram | The inline SVG diagram of Tally's parts on How Tally works; scales to the screen width, with a title and description for screen readers. |

## Patterns
- Feedback after an HTMX change: `HX-Trigger: {"toast": {"message", "type"}, "announce": "..."}`.
- Who picked a category: when Jev picked it, a muted `text-sm` line under the category chips says "Picked by Jev · N% sure". A person's choice and a merchant rule show nothing extra.
- Edits: the form saves, the list swaps back with the toast and announcement, and focus returns to the row (or to the result count if the row left a filtered list). Without JavaScript the save redirects back to the list.
- Result count: the `aria-live` line above a list names every active filter ("12 transactions needing a category in September", "Showing 1–25 of 35 transactions in Groceries, September"), so any filter change changes its text and is announced.
- Edit panel layout (owner's pick C, #27): the category chips first; then two toggle chips, "Always for this merchant" and "Exclude from budget"; then "Rename or add a note" behind a disclosure, which opens itself when there's a note or an error. An excluded transaction says "Excluded from the budget" with the transfer icon under the date. One "How this works" link.
- Disclosure: `<details>` with a `<summary>` row (44px) led by a chevron that turns when open (`group-open:rotate-90`); no JavaScript.
- Settings list (round 5 studies, #55): each category is a disclosure row (icon, name, "$600 a month" with "a month" muted, chevron at the far right) that opens in place to edit. Name and "Budget from <month> on" sit side by side on desktop. Save and Cancel sit on one line with Archive, a terracotta text button, at the far right; Move up and Move down, outline buttons, sit below. "+ Add category" is a terracotta disclosure row; "Archived (n)" lists archived categories with Restore.
- Extra actions in a form (Archive, Move): a second submit button with `formaction` and its own `hx-post`, so it works without JavaScript and never needs a form inside a form. Anything the action needs goes in its URL (`…/move/up`), because htmx doesn't send which button was pressed.
- Excluded rows in a list show a muted transfer icon and the word "Excluded" (never color alone).
- Sheet backdrop: `bg-ink/30` (ink at 30%), used only behind the BottomSheet; it is decorative, so no contrast target.
- Explainer page (How Tally works): each section is a serif h2 with an `id` the HowLinks point to, the rule in a short list quoted from the spec, and a worked example in a band-tinted box ("In the demo: …") computed by code from live numbers. When a rule changes in the spec, its section changes in the same PR.
- Illustrations: SVG, drawn with the icon stroke rules, ink plus one accent. Generated images never ship.
- Money: integer cents in the database and in code; format only in views with `formatCents` (src/money.ts).
- Motion: budget bars fill on load (CSS). `prefers-reduced-motion` shows the final state. No count-up: it would need custom JavaScript.
- Bars are inline SVG. The CSP forbids style attributes, and SVG width attributes aren't CSS.

## Governance
- A visual change starts as a generated study, gets owner selection, and is recorded in docs/design-concepts/README.md.
- A new token or component updates this file in the same PR, with its contrast value if it's a color.
- Accessibility: 44px targets, focus-visible ring, labeled forms, every HTMX swap announced through an aria-live count or announcer, or by moving focus (never a live list).

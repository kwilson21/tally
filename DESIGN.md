# Tally design system

Direction: "Illustrated ledger" (docs/design-concepts/README.md). Calm, warm, glanceable in under 3 seconds. A well-kept paper ledger with a little personality.

## Principles
1. One thing matters per screen. It gets the serif, the size, or the band. Nothing else competes.
2. Status is never color alone. Every red or green state also has an icon and a word.
3. Categories and status never share a hue. Status: green/brick. Categories: blue, plum, slate, ochre, brown.
4. Terracotta means "you can click this." Links and the current nav item only.
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
| Planned (Phase 1c): ProgressRow, TransactionRow, CategoryChip, BottomSheet, FormField, Band | Built when the first screen needs them. |

## Patterns
- Feedback after an HTMX change: `HX-Trigger: {"toast": {"message", "type"}, "announce": "..."}`.
- Illustrations: SVG, drawn with the icon stroke rules, ink plus one accent. Generated images never ship.
- Motion: bars fill and the headline counts up. `prefers-reduced-motion` shows the final state.

## Governance
- A visual change starts as a generated study, gets owner selection, and is recorded in docs/design-concepts/README.md.
- A new token or component updates this file in the same PR, with its contrast value if it's a color.
- Accessibility: 44px targets, focus-visible ring, labeled forms, aria-live on swap regions.

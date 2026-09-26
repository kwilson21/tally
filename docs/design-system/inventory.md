# Design system inventory (#76)

Every component and flow in the original app's catalog (`kwilson21/superhuman-personal-finance`, `django_app/design_system/`), what makes it intuitive, Tally's equivalent, and a verdict.

- **Keep:** Tally already has it or the spec needs it now; it goes in the catalog.
- **Adapt:** the spec needs it; bring the original's details over in Illustrated ledger tokens, through the catalog.
- **Later:** the spec needs it in a later phase; it enters the catalog with its feature.
- **Enhancement:** the owner wants it for the feel of the app (decision 45), though nothing depends on it. The app works without it; its script gets its own allowed-JS decision, and what it does in Tally is agreed with the owner, when it's built through the catalog.
- **Not needed:** not in the spec, or the app would need custom JavaScript beyond Plaid Link, toast.js and money.js (CLAUDE.md) that no issue or decision asks for. #72 and #73 are Adapt because each already asks for its own allowed-JS decision. The catalog's `ds.js` (decision 44) only runs catalog controls, so it doesn't change these verdicts.

## Foundation and motion
| Original | Intuitive details | Tally | Verdict |
|---|---|---|---|
| Colors | Swatch, hex and use for each token | Tokens in `app.css` and DESIGN.md | Keep: swatches drawn with the real token classes, so a changed token shows at once |
| Typography | Sample per role, with its classes | DESIGN.md type roles | Keep |
| Spacing, radii | Scale shown as shapes | `rounded-control`, `rounded-sheet` | Keep |
| Shadows | Warm shadow scale | None except toasts | Keep (one row: "no shadows except toasts") |
| Scrollbar | Thin sand thumb | Browser default | Not needed |
| Duration and easing demos | Play buttons animate each curve | Bar fill only | Not needed |
| Reduced motion | Toggle simulates the media query | `prefers-reduced-motion` shows the final state | Keep as a visual note |

## Primitives
| Original | Intuitive details | Tally | Verdict |
|---|---|---|---|
| Buttons (primary, secondary, danger, ghost, disabled, saving) | Press scale 0.97; the saving state has a spinner | Ad-hoc classes (Save, Cancel, Move up/down, terracotta text buttons) | Adapt: one Button component; the saving state comes with #69 |
| Text inputs (default, filled, error, disabled) | Error in `role="alert"`, `aria-invalid` | FormField | Keep |
| Currency input | ±$1, ±1¢ arrows, two-decimal cap by string, disabled floor at min, round-up chip only with cents, anchor chip dims when equal | MoneyInput (#66, #75, decisions 39 and 41) | Keep: first component through the process, checked against the original side by side |
| Password input | Show/hide toggle | Cloudflare Access (no passwords) | Not needed |
| Select | Custom chevron | Chips instead of selects | Not needed |
| Checkbox, radio, toggle | Hidden peer input, focus ring | Chip (checkbox and radio) | Keep |
| Status badges (paid, due, overdue, missed, future) | Word plus color | None yet | Later (bills, Phase 3) |
| Progress bar (under, warning, over) | Three states | Bar in ProgressRow (two states, notch at the limit) | Keep |
| Spinner | Three sizes | None | Adapt with #69 ("Saving…") |
| Focus rings | `focus-visible:ring-2` only | Same rule | Keep |
| Tooltip | Tap or hover, `aria-describedby` | HowLink instead | Not needed |
| Sync button (default, retry, syncing) | Disabled while syncing | None | Later (Accounts, Phase 2) |
| Accessible date input | Format hint, live announcer | Dates come from Plaid | Not needed |
| Batch action bar | "N selected", overflow menu | None | Not needed (not in spec) |
| Empty state | Icon, title, hint, optional action | None as a component | Adapt |
| Split row | Amount, category grid, notes | None | Later (splits, Phase 3) |

## Layout
| Original | Intuitive details | Tally | Verdict |
|---|---|---|---|
| Sidebar, bottom nav | Same destinations on both | Sidebar, BottomTabs | Keep |
| Month navigation | Previous/next month | None | Adapt with #68 |
| Filter bar | Search, pills with ×, mobile sheet | Transactions filters and result count | Keep (as it is now) |
| Page shells | Wireframes of each shell | Layout | Keep |

## Cards and surfaces
| Original | Intuitive details | Tally | Verdict |
|---|---|---|---|
| Budget summary (on track, over) | Health alert when over | Headline amount, status sentence, LedgerIllustration | Keep |
| Transaction rows | Desktop hover actions, mobile expand | TransactionRow (one link to the edit panel) | Keep |
| Bill entries | paid, due, overdue | None | Later (Phase 3) |
| Target entries (on track, warning, over) | Stacked on phones | ProgressRow | Keep; "$120 left / $40 over" comes with #67 |
| Refund and split badges | Words, 44px targets | "Excluded" marker | Keep; split badge later |
| Alerts and banners (uncategorized by urgency, stale accounts, getting started) | Urgency levels | Band, demo banner, Things to try | Keep; reauth banner later (#21) |
| Budget status text | Word per status | Status sentence | Keep |
| Inline category picker | `role="listbox"` grid with arrow keys, Home, End | Category chips in the edit panel (radio group, arrows move natively) | Keep |
| Profile card | Links to Settings | Access handles identity | Not needed |
| Connected accounts (healthy, needs reauth) | `<details>` expand | None | Later (Accounts, Phase 2) |
| Card hover lift | 2px lift, shadow | No cards, no shadows | Not needed |

## Overlays
| Original | Intuitive details | Tally | Verdict |
|---|---|---|---|
| Dialog (basic, form, danger) | Escape and backdrop close, focus trap, focus restored | BottomSheet (not modal; Cancel or backdrop) | Keep BottomSheet; a modal dialog (Escape, focus trap, focus restored) is an Enhancement |
| Dialog form variants | Hero amount, "optional" divider, compact category grid, rename suggestion chips | MoneyInput, edit panel | Keep; rename chips later (name suggestions, Phase 4) |
| Toasts (success, error, info, undo) | Auto-dismiss 4s, above the mobile nav | toast.js | Keep; Undo comes with #70 |
| Keyboard shortcuts modal | `?` opens it | None | Adapt with #72, which needs its own allowed-JS decision (a small `keyboard.js`, as #72 says); the list itself is a `<details>` that reads without it |
| Split modal | Live "Remaining", submit disabled until it balances | None | Later (Phase 3; server-checked) |
| Category create, edit, delete | Create and edit states | Settings disclosure rows | Keep |
| Disconnect bank, danger zone | Confirm first | None | Later (Accounts) / Not needed |
| Bottom sheet (mobile) | Drag handle, swipe or backdrop dismisses | BottomSheet (backdrop, Cancel) | Keep; swipe-to-close is an Enhancement |

## Feedback and states
| Original | Intuitive details | Tally | Verdict |
|---|---|---|---|
| Loading indicator | Appears only after 300ms, so fast requests never flash | None | Adapt with #69 (CSS on htmx's request class) |
| Content spinner | Fades in over the list | None | Not needed |
| Empty states (bills, targets, generic) | Action when there is one | None | Adapt (with Empty state above) |
| Form validation, field shake | Shake the field for 400ms, not the message; `aria-invalid`, `role="alert"` | FormField error | Adapt with #69 |
| Banners (reauth, offline, adblock) | Forced visible in the catalog | Demo banner | Offline with #73, which needs its own allowed-JS decision (a small `offline.js`, as #73 says); reauth later; adblock not needed |
| Form and budget errors | Inline, specific | FormField | Keep |
| Uncategorized banner | Count and link | Band | Keep |
| Picker loading and success check | Confirms the change | Toast, focus back to the row | Adapt with #71 (highlight) |
| Error pages 404, 500 | Same shell | Check what Tally renders | Adapt |

## Animations and gestures
| Original | Tally | Verdict |
|---|---|---|
| Budget bar fill | CSS fill on load | Keep |
| Transaction and new-item highlight | None | Adapt with #71 (CSS) |
| Undo delete sequence (row exits, 5s countdown) | None | Adapt only what #70 needs |
| Enter/exit, pop, expand, stagger, swap transitions, scroll reveal, pulse, swipe hint | None | Not needed |
| Swipe on a row, pull to refresh, drag, sheet swipe | None | Enhancement (each gesture's action agreed with the owner first; Tally deletes nothing, so a row swipe would do something else, such as exclude) |

## Flows
| Original (steps) | Tally flow | Verdict |
|---|---|---|
| Categorization (4) | Edit a transaction: chips, "Always for this merchant", Exclude, rename | Keep: first flow |
| Budget setup (4) | Change a budget on Home: row → sheet → MoneyInput → save → toast | Keep: first flow |
| Settings (9 tabs) | Settings categories: rename, archive, restore, move, add | Keep |
| Filter bar (3) | Transactions filters and result count | Keep |
| Plaid Link (4) | Link a bank, Fix connection | Later (Phase 2, #16, #21) |
| Split (3) | Split a transaction | Later (Phase 3) |
| Keyboard shortcuts (2) | Shortcuts | Adapt with #72 (after its allowed-JS decision) |
| Onboarding (6) | Things to try (demo only) | Adapt with #95 (decision 49): its care and guidance, not its length |
| CSV import (4) | None | Not needed (Later list: statement upload) |
| Reorder (2) | Move up/down in Settings | Enhancement: drag to reorder, with Move up/down kept |
| Select mode (4), organize (1) | None | Not needed |

## Process pieces
| Original | Tally | Verdict |
|---|---|---|
| Three tiers as pills (`data-ds-tier`, CSS `::before`) | None | Keep |
| `hx-disable` on visual tiers | htmx 4 renamed it `hx-ignore` (checked in `node_modules/htmx.org/dist/htmx.js`); `hx-disable` now disables elements during a request | Adapt: `hx-ignore`, plus a catalog-only CSP `form-action 'none'` so no form can submit without JavaScript either |
| `ds-sandbox.js` (intercepts requests) | `ds.js` runs catalog controls only (decision 44); nothing intercepts or fakes requests | Adapt |
| `{% include %}` of the real partial | Import of the real Hono JSX component | Keep: it's the only way the catalog can render a component |
| `mock_data.py` factories plus `check_ds_contracts` | Typed mock data: TypeScript checks every prop at `npm run typecheck` | Keep the mock data; the contract check isn't needed |
| Flow steps in the session | `?step=N` in the URL; server-rendered, no session | Adapt |
| DEBUG-only gate | Mounted only when `DEMO` is `"true"` (demo and dev); production returns 404 | Adapt |
| `/interface-design:audit` against `system.md` | Audit against DESIGN.md (checklist in the PR) | Adapt |
| Token lint (`check-design-tokens.sh`) | None | Adapt as a unit test (no arbitrary values, no off-token radii) |
| Screenshots at 1280 and 390, owner checks | CI already screenshots every page; the catalog becomes pages | Keep |
| DS-EXCEPTION comments with expiry | Decisions (for example 40 → 41) | Keep decisions; no inline exceptions |

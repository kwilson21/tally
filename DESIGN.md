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
| Voice | Plain, second person, calm; numbers first, then what they mean ("$120 left") | Shout (capitals, exclamation marks), blame ("you failed"), or use bank jargon (raw merchant strings, "debit", "posted"), except the small muted bank text under a name tidied from it (#93) |
| Motion | Confirms that something happened (a bar fills, a row is highlighted, or a field with an error shakes once) | Decorate, bounce, or delay; reduced motion always shows the end state and doesn't move an invalid field |

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

Radii: `rounded-control` (0.75rem) for inputs, chips, buttons; `rounded-sheet` (1.25rem) for the bottom sheet top corners. From decision 76 both are drawn as squircles (`corner-shape: squircle`) where the browser supports it; elsewhere they stay round, and chips stay pills. No shadows except toasts.

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
| Wordmark, TallyMark | The tally-mark glyph plus serif "Tally"; the brand. The wordmark is a link Home with a 44px-tall target. |
| Icon | Lucide line icons, 1.75 stroke, currentColor, always aria-hidden. |
| Sidebar / BottomTabs | The same destinations: a sidebar on desktop, four tabs plus More on phones. |
| Layout | Every page's shell: banner, navigation, main, toast and announce regions. |
| CategoryIcon | A category's line icon, drawn in its color token. |
| ProgressRow | One category: icon, name, "spent of budget," and a 4px bar with no limit marker (decision 46); over budget, the bar is full and brick, with an alert icon and how much it's over in words ("$36 over"). In Adjust mode (#94) it adds a round − before the row and a round + after it, each a form that moves the budget to the next round $10; on a phone − takes the icon's place, and its bar redraws without replaying the fill. When the name and amount don't fit on one line, the amount moves under the name, breaking at "of" if it must, never inside a number. |
| AdjustLink | "Adjust" beside Home's Budget heading, a terracotta text link that shows − and + on every budgeted row; in Adjust mode it says "Done". |
| Band | The one tinted row per screen that links to the thing to do next, with an optional quiet second line (Home's "$228 of this month's spending", decision 50). |
| HomeTop | Home's top (#92, decision 46): the month as a small serif heading, then Safe to spend (the one thing, on a phone's first screen), the status sentence, How this works, a BankLine when a connected bank has stopped syncing, and the Band, which carries the uncategorized amount (decision 50). On desktop the top and the Budget list share one width. |
| BankLine | Home's line for a connected bank that needs signing in or hasn't synced for 3 days (decision 72, P37 A): an alert icon (never color alone), the words in ink, not brick ("Chase hasn't synced since Oct 1, so Safe to spend may be too high." or "Chase needs you to sign in again, so …"; with two or more banks it names the first and counts the rest, "…, and 1 other bank needs a look, so …"), and a terracotta "Check Accounts" link to Accounts with a 44px target. It sits between the status sentence and the Band, so the Band keeps its job; it goes once the bank is fixed or syncs again, and it never appears in the demo. |
| AccountsTop | The Accounts screen's top (round 5 study): the title, Net worth in whole dollars as the serif headline, and under it the NetWorthChart in the ruled space. |
| NetWorthChart | The line under Accounts' headline (P25 A, P26 A, P31, decision 64): a sentence of the change in the status sentence's voice, written by code ("Up $3,600 since May.", "Down $1,200 since May.", "No change since May."; a history that began this month names the day, "Up $120 since Oct 1."), followed by a terracotta "Why?" (WhyLink, separated by " · ") to the Net worth section of How Tally works, which says what counts, why a day has one balance and why the line starts when every account has one, then one server-drawn SVG line through the last 6 months of net worth on four ledger rules (the 6 months include this one so far), with its first and last day under it in muted words ("May", "Today"). No amounts, axis or hover: the headline and the sentence carry the numbers, and the SVG's text alternative says the same in dollars. The line is spaced by date, fills the page's width and keeps its strokes and end dot the same size (non-scaling strokes). Net worth is every account's balance with debt subtracted (leaving out the Cash account and disconnected banks), from one balance a day recorded when a sync refreshes balances; the line starts on the first day every counted account has one, so linking another bank never looks like growth, and while a connected account has no balance recorded at all there is no line (it would add up fewer accounts than the headline) and only the note "The chart starts once every account has a balance." shows. Under two days of balances it is the five empty rules, a sentence ("Tally started following your balances today.") and a muted note ("The chart starts tomorrow, with a second day of balances."; with no balance yet, only "The chart starts with the next sync."). Account rows keep today's balance only. |
| BankGroup | One linked bank: its name in muted sans and a muted “Synced …” line (left out before its first recorded sync and in the demo), its AccountRows between rules (before its first sync, the muted line "Accounts appear after the first sync." instead), connection status in words, and repair when needed: "Needs attention: sign in again" with an alert icon (never color alone) and a secondary "Fix connection" button. A no-JavaScript Manage disclosure holds the secondary "Disconnect this bank" action. A disconnected bank keeps its AccountRows and says "Disconnected" in muted words, with no Synced line, Manage, Needs attention or Fix connection. |
| SyncNow | "Sync now", the secondary button under the Accounts title (P12 A) that syncs every healthy bank, at most once a minute each. Resting "Sync now"; while pending "Syncing…" with the spinner; done, a toast of what arrived ("3 new transactions", "Nothing new", "Already synced a moment ago.", or "Fix the connection first.") and the banks redrawn; failed, one alert above the summary naming the bank ("Couldn't sync Chase. Try again later."). |
| AccountRow | One account: a bank or card line icon, its name, "••4521" (read as "ending in 4521"), and its balance, with debt shown negative. |
| LedgerIllustration | The notebook-and-pencil line drawing beside the headline; ink plus a terracotta pencil. |
| TransactionRow | One transaction as a single link to its edit panel: icon, name, category or status in words, signed amount. A pending one (P34 A, decision 72) adds "Pending" in muted words to the same caption line, never cut off, with no new tag or color, and the row stays in date order: after a lone category or Income ("Groceries · Pending"), in the bank text's place on a row that needs a category ("Pending" beside the Needs category tag), and first when the caption already says more ("Pending · Excluded", "Pending · Groceries · Split from Costco", "Pending · Groceries · Refund for Oct 1", "Pending · Groceries · Counts in September"). |
| PendingNote | The muted line under a pending transaction's date in its edit panel: a clock icon and "Pending. The bank hasn't finished it, so its amount can still change." (P34 A, decision 72). |
| SelectableTransactionRow | One transaction in select mode: a 44px-or-larger label with a keyboard-focusable round checkbox, name, status and signed amount. |
| BillStatusHeading | A bill group heading pairs its status icon with the status in words, never color alone. |
| BillRow | One bill: category icon, name, due or paid status sentence, and amount from integer cents. When a payment from the same merchant came at another price (P36 B, decision 72), the status sentence is two caption lines instead, "Price changed?" in ink and "Paid $17.99 on Oct 3" in muted words; the row grows a line, keeps its status heading and its own amount, and still links to the bill's page. |
| BillFindingBand | The Bills screen’s terracotta-ruled Band shows how many repeat-charge suggestions need review. |
| BillFindingRow | One possible bill with its latest amount and timing, plus Add and permanent Not a bill actions. |
| EmptyState | Where a list would be when it's empty: a small line drawing (magnifier: no results; tick: nothing to do; add sign: one thing to start), one sentence, a muted hint and at most one button, centred (decisions 54, 55). The button is a secondary link, or, for an add, the screen's own primary control passed in. |
| BillOccurrenceRow | One bill occurrence with its status, linked-payment detail, and link or “Not this one” action. Older unpaid occurrences are neutral. When a payment came at another price (P36 B, decision 72), the month the Bills row shows asks instead of offering a link: "Netflix charged $17.99 on Oct 3, not $15.49.", a muted line saying what updating does, the one primary "Update the bill to $17.99" (links that payment and changes the bill's amount) and terracotta text "Not this bill" (turns the payment away for that month). Each is its own form, so both work without JavaScript. |
| BillPaymentPicker | Eligible payments and unpaid occurrence choices as Chip radios; no payment is chosen in advance, so the person picks one. An excluded payment can pay a bill and is listed with "· Excluded" in words; linking it puts it back in the budget. Its empty state has no submit action. |
| ErrorPage | The app's own 404 and 500 pages (decision 72, P39 C), inside the Layout so the navigation is there and nobody is stuck: LedgerIllustration at 176px, a serif "404" or "500" (read as "Error 404"), one sentence and a way back. The 404 says "This page isn't here." with a secondary "Go to Home"; the 500 says "Something went wrong on our side.", a muted "Nothing you did. Your data is safe; try again in a minute.", a secondary "Try again" and a terracotta "Go to Home". Try again retries a failed GET on its own address; a failed form post goes back to the page the form was on (the Referer's path and query, only when it is this site's, never one that starts with "//"), and with no such page there is no Try again and "Go to Home" is the one secondary button. It never shows what failed: no message, code or request detail. |
| Chip | A pill-shaped checkbox or radio (optionally with an icon); the real input is visually hidden but keyboard-reachable. A checkbox chip is a toggle and shows a check mark while on, so its state isn't color alone. `required` on one radio makes its group required. A checkbox chip can answer an alert: `describedBy` ties it to the alert line it confirms, and its value is the exact amount confirmed (a bill over $100,000.00 saves only once "Yes, $150,000.00 is right" is ticked, decision 72); it stays ticked, with the alert line gone, when another field needs fixing. Inside a disabled fieldset it fades to 40% and shows a not-allowed cursor, as Button does (the edit panel's category chips while a refund is linked to its purchase). |
| Switch | A real checkbox drawn as a switch (decision 73, P41 B): the label, an optional muted line, "On" or "Off" in words, then a track with a knob that sits left when off (pale track) and right when on (ink track), so state is never color alone. The whole 44px row is the target with a focus-visible ring, the knob slides in 150 ms (reduced motion shows the end state at once), and the state comes from the checkbox alone, so it works without JavaScript: on posts `on`, off posts nothing. A screen reader hears a switch named by the label and described by the muted line; the On/Off words and the track are hidden from it. |
| FormField | A labeled control, with its error shown in `role="alert"`. |
| Button | A primary, secondary, or quiet text action, rendered as a button or link; an HTMX submit can keep its size while showing a still-or-spinning ring and action-specific busy label, and is disabled for the request. |
| TextInput | A labeled single-line text field with accessible error and disabled states; an invalid field shakes once, while reduced motion keeps it still. |
| BottomSheet | A page region over the list (bottom sheet on phones, right-hand panel on desktop) with a dimmed backdrop; not a modal, closed by Cancel or the backdrop. |
| FeedbackButton | A small, fixed, shadowless pill at bottom-right links to the feedback form, which records the page it came from (a same-origin Referer). |
| FeedbackForm | A new report stores a random one-hour limiter token, submission time, type, feeling, redacted message, route category and coarse device category in Cloudflare D1; it does not store the verified sign-in email. Optional technical details add only an allowlisted error name. Private GitHub filing uses the same redacted report fields and omits the limiter token and submission time. Replay is absent, and the geometry-preview code is hard-disabled pending pixel/OCR acceptance. Production diagnostics flags remain off. |
| ThingsToTry | The demo's bordered "New here? Things to try" block, below Home's Budget list until onboarding (#95) replaces it: three links to where each thing is done, plus How Tally works. |
| HowLink | A small "How this works" link under a screen's title to its section of How Tally works. |
| WhyLink | A small terracotta "Why?" after a label, separated by " · ", linking to the exact section that explains the rule, with a distinct accessible name and a 44px target. |
| TrendsTop | Trends' one thing (P23 D, P24 A): what's spent so far this month as the serif number, then a sentence written by code comparing it with the same days last month ("$90 less than by this time in September."; "About the same as …" within a dollar), with a Why? after it. While last month is the part month Tally started in, or there is none, there is nothing to compare, so the sentence and its Why? are left out. |
| TrendGroup | A small muted heading over a ruled list on Trends: Going well takes a check in ok and Worth a look an up arrow in ink, each with a Why? (never color alone); the changes and every other category have a plain heading. |
| TrendRow | One category on Trends: its icon, name, a line of words ("4 months under budget", "Up 3 months running", "$150 in September") and six small ink bars scaled to the row's tallest month, the last (the month still going) a dashed outline; a short history sits at the right. A Worth a look row that is also under budget three or more months running adds a muted second line, "Still under budget". The first small bar is striped like MonthBars' when that month is a part month. The bars are inline SVG with a text alternative that says each month's amount ("May (from May 12) $820, June $790, …, October so far $196"). |
| ChangeRow | One category's change since the same days last month, in words with an arrow ("Up $31", "Down $28"); spending more isn't a status, so it stays ink, and equal amounts say "No change" with no arrow. |
| MonthBars | All spending by month as bars on ledger rules with each amount above it, the month still going a dashed outline saying "so far", and the first month of history, when history starts after its 1st so it may be only part of a month, striped (an SVG pattern of diagonal ink stripes on paper, named by an `id` so two charts on a page don't share one): Trends' early state (P31), before there's a full month to compare. Its text alternative says the part month and from when ("September (from Sep 12) $260"). The same stripe marks that month in each TrendRow's small bars. |
| MoneyInput | The owner's hero amount from the original app (#66), in Tally's tokens: a round −$1 button (48px), a 292px amount field (`$`, the amount in bold 1.75rem, always with cents: "700.00") with ▲▼ cent arrows stacked inside its right edge behind a hairline (each 44×44: the field is 90px tall so the stacked arrows meet the touch-target rule, decision 41; the amount input fills the field's whole height, so a tap anywhere in the field focuses it), and a round +$1 button. Under it, centered chips: "Round to $X" (only with cents) and "Last month: $X" (dimmed when the field already holds it). Minus buttons are disabled at $0. In the field, ↑ / ↓ change the amount by 1¢ (Shift: $1), as the original's number field did. money.js runs it; without it the buttons and chips are hidden. |
| CashForm | P21 A's edit-panel-shaped form adds dated cash spending with where it was spent, a category and an optional note. It carries a hidden one-time key made each time it is drawn, so posting it twice (Save again after "Couldn't save", a lost reply) records one transaction; a repeat changes nothing and its toast names what was really saved. |
| SplitForm | P17 option A: two or more category-and-MoneyInput part rows, Add a part, and a polite live line above them that says “$X left to assign,” “$X over,” or “Adds up to $Y” with a check; save remains server-validated. |
| SystemDiagram | The inline SVG diagram of Tally's parts on How Tally works; scales to the screen width, with a title and description for screen readers. |
| BudgetDiagram, BillsDiagram, TransactionsDiagram, ExclusionsDiagram, CategoriesDiagram | How Tally works' section diagrams (#61), drawn from the same numbers as each worked example: boxes and arrows for Budget, Bills, Transactions and Categories; one bar for Excluding. Ink, muted and rule only, plus ok (or over) on the safe-to-spend box, always with its words. A dashed outline means "not counted" or "not decided yet". |

## Patterns
- Bill page (P16 A/P22): newest occurrence first, with its status and linked payment; “Link a payment” opens the 30-day picker and month choice in the page, while “Not this one” rejects a match. When a payment came at another price (P36 B), the month the Bills row shows asks to update the bill instead, and "Not this bill" turns that payment away for that month.
- Organize screen (owner's P10 option B): one uncategorized merchant group at a time, largest total first, with category chips, an optional shared name, and Save or Skip actions.
- Empty lists: every list that can be empty shows EmptyState, never a blank space or a lone muted line.
- First visit's Transactions (P40 A, decision 72): with no transaction in any month, the page keeps its title, Add cash and How this works, and drops Select, search, the filters and the result count until the first transaction arrives. Its EmptyState says "Link a bank to see transactions." (the add sign, a secondary link to Accounts) while no connected bank is linked, and "Importing your transactions…" (the magnifier, no button) once one is. A month or filter with no results keeps "No transactions match these filters." The demo never shows either. A save that ends this page, or a delete that brings it back, swaps all of `<main>` rather than only `#page`, since the controls sit outside `#page`.
- Trends (P23 D, P24 A, P31, P33 A; spec §8.3): one column. TrendsTop, then the changes under "Oct 1–5 against Sep 1–5", biggest first, with a "Needs a category" row (Home's words) so they add up to the number above; then Going well, Worth a look and every other category as TrendRows, each list only when it has rows (a category that is both under budget and rising is only in Worth a look, with a muted "Still under budget" second line). The six months run from the month Tally's history starts and include this one, dashed; history starts on the first transaction's own date, and when that is after the month's 1st that month is only partly there, so it is drawn striped (in every chart) but never judged, compared or put in a run; a history that starts on the 1st is a full month. This month isn't judged until it's over. While last month is the part month Tally started in, or there is no last month, there is nothing to compare, so the page is TrendsTop with no sentence (and no Why?), then MonthBars and "Trends fill in as months pass. Tally started in September."; with no transactions, an EmptyState. Nothing on it takes an action, so nothing needs announcing; its only links are How this works and Why?.
- Feedback after an HTMX change: `HX-Trigger: {"toast": {"message", "type"}, "announce": "..."}`.
- A failed request (decision 72, P38 A): when the connection drops (`htmx:error`) or the server answers 500 (`htmx:response:error`, an unhandled error), toast.js shows the error toast and leaves the page as it is, so an open sheet keeps what was typed and its Save comes back to rest. It says "Couldn't save. Check your connection and try again." for a POST, PUT, PATCH or DELETE, and "Couldn't load. Check your connection and try again." for a GET (a filter, opening a sheet), read from the request's method. A request still running after 60 seconds is aborted and says the same (toast.js keeps that timer; Layout's `htmx-config` sets `defaultTimeout` to 0, since htmx 4 aborts a timeout exactly as it aborts a replaced request). A 500 reply is never swapped in (`noSwap` in Layout's `htmx-config`). Every other 4xx and 5xx still swaps and says its own words on purpose: a field's error (422), or a bank that couldn't be reached (502). An error toast is `role="alert"` and leads with the alert icon in `text-over`, never colour alone. The toast region sits above the BottomSheet (`z-60`; the sheet is `z-50`) and lets taps through, so Save can be tapped again. An htmx request that gets the app's 404 or 500 gets no body and `HX-Reswap: none`, never ErrorPage, so nothing in the page is replaced or removed; the 404 says "This page isn't here." in the error toast and the announcer (`HX-Trigger`), and the 500 is spoken by toast.js.
- Who picked a category: when Jev picked it, a muted `text-sm` line under the category chips says "Picked by Jev · N% sure". A person's choice and a merchant rule show nothing extra.
- Edits: the form saves, the list swaps back with the toast and announcement, and focus returns to the row (or to the result count if the row left a filtered list). Without JavaScript the save redirects back to the list.
- Result count: the `aria-live` line above a list names every active filter ("12 transactions needing a category in September", "Showing 1–25 of 35 transactions in Groceries, September"), so any filter change changes its text and is announced.
- Edit panel layout (owner's pick C, #27): the category chips first; then two toggle chips, "Always for this merchant" and "Exclude from budget"; bank-credit states use the same chip component for "Count as income" and "Reviewed as a refund or other non-income credit"; then "Rename or add a note" behind a disclosure, which opens itself when there's a note or an error. A pending transaction says so under the date (PendingNote); an excluded one says "Excluded from the budget" with the transfer icon under that. One "How this works" link.
- Disclosure: `<details>` with a `<summary>` row (44px) led by a chevron that turns when open (`group-open:rotate-90`); no JavaScript.
- Home budget rows (#66): each row is a link to its budget sheet (a BottomSheet over Home, like the edit panel), with a screen-reader-only ", change the budget". Categories with no budget sit under a small muted "Not budgeted" heading, each ending in a terracotta "Add a budget". Adjust mode (#94, decision 48) is specified in the catalog, next to its specimen, with all eight parts of its use spec. On Home it's `/?adjust=1`: Adjust, Done and each − or + swap `#page` in place; taps queue on the body (`hx-sync="body:queue all"`), so rapid taps apply in order; focus stays on the tapped button by its id, and moves to the row's other button when a tap reaches $0 or the largest budget. Without JavaScript each button posts and redirects back to `/?adjust=1`.
- Settings list (round 5 studies, #55): each category is a disclosure row (icon, name, "$600 a month" with "a month" muted, chevron at the far right) that opens in place to rename. Its budget is changed on Home (decision 38), through a "Change its budget on Home" link in the open row. Save and Cancel sit on one line with Archive, a terracotta text button, at the far right; Move up and Move down, outline buttons, sit below. "+ Add category" is a terracotta disclosure row; "Archived (n)" lists archived categories with Restore.
- AI suggestions (Settings, decision 73, P41 B): a group between Categories and Your data. The heading "AI suggestions" and one muted line ("Off means your rules and choices only. Nothing already decided changes."; with every switch off, "Tally sorts by your rules and choices only."), then a Switch between rules for each AI feature that exists (Categories and exclusions; Income), each with its muted line, and one Save under them. Merchant names and Sort new transactions as they arrive are stored (on to start) but get their rows when the features that read them ship (Workers AI names, the Jev run after a sync), so no switch promises something that isn't built. Save posts the group, `/settings/ai`: a switch left out is off, and a switch the group doesn't show is never changed. With htmx it swaps the group in place, the toast says "Saved AI suggestions", the announcer reads every shown switch's state, and focus returns to Save; without it Settings reloads at the group. Words on screen say "Tally", never the name of the AI behind it.
- Extra actions in a form (Archive, Move): a second submit button with `formaction` and its own `hx-post`, so it works without JavaScript and never needs a form inside a form. Anything the action needs goes in its URL (`…/move/up`), because htmx doesn't send which button was pressed.
- Excluded rows in a list show a muted transfer icon and the word "Excluded" (never color alone).
- Sheet backdrop: `bg-ink/30` (ink at 30%), used only behind the BottomSheet; it is decorative, so no contrast target.
- Explainer page (How Tally works): each section is a serif h2 with an `id` the HowLinks point to, the rule in a short list quoted from the spec, and a worked example in a band-tinted box computed by code from live numbers: "In the demo for October: …" in the demo and "With your numbers for October: …" outside it, naming the month it uses. Outside the demo the page never names Jev; the AI is "Tally" (decision 64). The architecture part appears only in the demo. When a section has nothing to show yet, it uses one plain sentence and leaves out its diagram. When a rule changes in the spec, its section changes in the same PR.
- Illustrations: SVG, drawn with the icon stroke rules, ink plus one accent. Generated images never ship.
- Money: integer cents in the database and in code; format only in views with `formatCents` (src/money.ts).
- Cash: the secondary “Add cash” action opens a sheet; cash spending counts everywhere a bank transaction does, while the Cash account never counts in net worth.
- Motion: budget bars fill on load (CSS). `prefers-reduced-motion` shows the final state. No count-up: it would need custom JavaScript. From decision 76 (P74 A), quiet confirmations in CSS only: a switch's knob slides, a sheet rises, a toast fades in, and pages cross-fade through the browser's View Transitions, each 150 to 200 ms, with durations as tokens in app.css.
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
6. **The owner verifies** the app pages: Claude sends the pages that changed (CI's before-and-after) and, once the PR is complete, merges it (decision 51). The owner can check them after the merge, and anything they want changed becomes a follow-up or a revert.

**Visual decisions are made by seeing, not by reading.** Every proposal that changes how something looks is shown in the catalog as current and proposed, side by side, at 1280 and 390, before the owner decides. A decision entry is written only after that, and each accepted proposal ships in its own PR, so undoing it is one revert.

A backend-only change skips step 1.

## Governance
- A new screen's visual direction starts as a generated study, gets owner selection, and is recorded in docs/design-concepts/README.md. Its components then go through the catalog.
- A new token or component updates this file and the catalog in the same PR, with its contrast value if it's a color.
- Accessibility: 44px targets, focus-visible ring, labeled forms, every HTMX swap announced through an aria-live count or announcer, or by moving focus (never a live list).

# Gaps from the original app (Oct 5 review)

The owner asked whether anything from the original app (`kwilson21/superhuman-personal-finance`) was being missed. Four independent sweeps compared it with Tally's spec, decisions and code. They covered:
- its written designs and plans;
- its money rules;
- its screens and behaviour;
- its GitHub backlog (102 issues, including the family's beta feedback).

Every gap is listed here, so nothing is lost. The owner accepted every **Proposed** placement in decision 67 (Oct 5); "Fix now" items form Phase 3.5 (spec §8.5), and Phase 5 items are still drawn and picked before they are built.

Already decided: decision 66 for receipts and the Phase 5 eight, and decision 65 for "Why?" links.

## A. Numbers that can be wrong in the family app today

These are rule gaps rather than missing features: each can make Safe to spend or Spent wrong. All were checked in Tally's code.

| # | Gap | What happens in Tally | Original app | Proposed |
|---|---|---|---|---|
| A1 | Income is never set | A paycheck counts as negative spending, so Safe to spend rises by the whole paycheck and Income shows $0. Jev's income answer isn't stored (decision 28) and nobody can mark income. | Plaid's INCOME category sets it at sync, and a person can pick the type. | Fix now. The other session's #149/#153 cover holding credits for review; a person still needs a way to mark income. |
| A2 | Pending charges dropped | Sync skips pending transactions (`src/plaid/sync.ts`), so Spent lags 1–5 days and Safe to spend runs high. A bill paid on its due day shows Overdue until it posts. | Counted, shown with a "Pending" marker. | Fix now (rule needed: count pending, and keep edits and links when it posts). |
| A3 | Transfers and card payments counted until night | Only Jev can exclude, and only nightly. Plaid's category is stored but used only as a hint. If one side of a card payment is missed, it counts twice. | Plaid's TRANSFER and LOAN_PAYMENTS categories are excluded at sync. | Fix now. |
| A4 | Month flips at UTC midnight | `todayUtc()` drives Home's month and bill status, so the budget resets around 7–8 pm US time on the last day of the month. | Local time zone. | Fix now (needs the family's time zone). |
| A5 | Bill matching too strict | It needs an exact `raw_name`, ±10% and ±5 days. An excluded payment, such as rent by Zelle that Jev flagged as a transfer, can never pay a bill, even by hand. Price rises over 10% and renamed merchants stay Overdue and set aside. | Weighted score on name, amount, date and category; matching ignores exclusion; "price changed?" prompt. | Fix now: allow excluded payments, and a near-match suggestion. |
| A6 | Merchant key is the exact raw text | Rules, bill matching, refunds and bill finding all need an identical `raw_name`. "TARGET 1234" and "TARGET 5678" are different merchants. | Plaid's cleaned `merchant_name`, with processor prefixes and numbers stripped. | Fix now (store Plaid's `merchant_name`). |
| A7 | Rules run late | After a webhook or cron sync, only bill matching runs. Merchant rules wait for Sync now or the night, so known merchants show Needs category. | All rules after every sync. | Fix now. |
| A8 | A refund can be excluded or over-linked | Jev's reimbursement flag can exclude a store refund, so it never reduces Spent. There's no check on the refund's amount, and nothing stops several refunds linking to one purchase. | Linking forces the refund back into the budget; refund ≤ purchase; one refund per purchase. | Fix now. |
| A9 | Bill guards | Nothing stops a duplicate bill (it can never be paid, so it's set aside forever) or a typo'd huge amount. Editing a bill rewrites past occurrences, including last month's overdue amount. | Duplicate-name and maximum checks; edits apply from this month on. | Fix now (guards); amount history in Phase 5. |
| A10 | A failed save does nothing | There's no htmx error handling: on a bad connection a save silently fails. Tally has no app-wide 404 or 500 page. | "Something went wrong" toast, error pages. | Fix now. |
| A11 | "Picked by Jev" still on screen | The edit panel shows it; spec §7 says it should say "Tally". | — | Already in #51's brief. |

## B. Home: warnings and explanations a family would notice

| # | Gap | Proposed |
|---|---|---|
| B1 | A negative Safe to spend reads "-$120 safe to spend". The original said "Over budget this month". | Phase 5 (design) |
| B2 | Nothing explains why Safe to spend is lower than the budgets add up to. The original showed "left minus unpaid bills". Decision 65's Why? links help. | Phase 5 |
| B3 | Near-limit warning: categories at 80%+ and "$X left". Tally has only on track and over. | Phase 5 |
| B4 | A bank that needs reconnecting, or that hasn't synced for days, isn't flagged on Home, so Safe to spend may be too high. | Fix now (banner) |
| B5 | Daily allowance: "about $X a day for N days". | Phase 5 |
| B6 | Spending in categories with no budget isn't shown with amounts. | Phase 5 |
| B7 | Older uncategorized transactions aren't mentioned on Home. | Phase 5 |
| B8 | A budget row doesn't lead to its transactions. Beta feedback asked for this (#39). | Phase 5 |
| B9 | No "Why?" link on bill status. Beta feedback: about 8 minutes confused by an Overdue badge (#53). | Add to decision 65's list |
| B10 | An overall spent-against-budget bar, and Income shown somewhere. | Later |
| B11 | No first-week getting-started checklist, onboarding wizard, or suggested budgets from a 3-month average. | Onboarding (#95) |

## C. Transactions

| # | Gap | Proposed |
|---|---|---|
| C1 | No way to mark a transaction as income, or change its type (paycheck, refund, payment, transfer). | Fix now (with A1) |
| C2 | No filter by type (income, refunds, transfers). | Phase 5 |
| C3 | Can't create a category from the edit panel or Organize. The strongest beta complaint (#20). | Phase 5 |
| C4 | Search doesn't match a category name or an amount (#32). | Phase 5 |
| C5 | Search defaults to this month, so last month's charge isn't found. | Phase 5 |
| C6 | Rename one transaction only, and name generic merchants (Apple, Amazon, PayPal) by amount (#6). | Phase 5 |
| C7 | No list of merchant rules to see or remove. "Always for this merchant" opens unticked even when a rule exists. | Phase 5 |
| C8 | Select all in select mode. | Phase 5 |
| C9 | The empty list on day one says "no transactions match" instead of "importing" or "connect a bank". | Fix now |
| C10 | Custom date range or a year view; export one category for taxes (#22). | Later |
| C11 | Faster cash entry and recent-merchant autocomplete (#23, #110). | Later |
| C12 | Exclude a whole category from the budget. | Later |
| C13 | Organize: split groups into this month and older; preview a group's transactions; opt out of the rule. | Later |
| C14 | "Apply to all" must refresh every visible row from that merchant (#79). | Check when building |
| C15 | Don't offer "This refunds…" on income or transfer rows (#76). | Check when building |
| C16 | A refund automatically linked when merchant and amount match within 30 days. | Later |

## D. Bills

| # | Gap | Proposed |
|---|---|---|
| D1 | Partial payments: a bill paid in two halves never shows Paid. | Phase 5 |
| D2 | A bill's category isn't given to its payments. | Phase 5 |
| D3 | Monthly bills total, and a yearly bill's monthly share. | Phase 5 |
| D4 | Bills and subscriptions told apart, with a subscription review. | Later |
| D5 | Add found bills in bulk (pre-ticked). | Later |
| D6 | Suggest a bill's amount from its last payment, with rounding (#68). | Later |
| D7 | A yearly bill requires its anchor month (#59, #80, #86). | Already enforced by the form and the schema; nothing to do |

## E. Household, reliability and other

| # | Gap | Proposed |
|---|---|---|
| E1 | Send a transaction to another family member to sort out (#24). | Later |
| E2 | Alerts: bills due, budget nearly spent (beyond the Phase 5 reconnect email). | Later |
| E3 | Error alerts, an uptime check and rollback steps (#104–106). | Later |
| E4 | Database CHECK constraints on money columns (#101). | Later |
| E5 | Walk every flow on a real iPhone (#100). | Before the Phase 3 deploy |
| E6 | Retry when a new bank's first sync is empty. | Later |
| E7 | A written data-retention policy, and "delete all our data". | Later |
| E8 | Sheets with up to 50 categories must scroll with their actions pinned (#62, #66); Feedback mustn't cover the last row's amount (#46, #54, #55). | Check in the catalog |
| E9 | A refund larger than its category's spending: how a bar below $0 looks (#92). | Spec line added (§6 Spent); wording with B1 |
| E10 | Business and personal spending; who handles which bill; sinking funds; a "Classic" theme; swipe-down to close a sheet; keyboard shortcuts; offline banner. | Later |

## Feedback themes from the family's beta (keep in mind)

1. "Why did this number change?" costs the most trust.
2. People look in the obvious place: search by category or amount, and tap a total to see what's behind it.
3. Being blocked at the moment of categorizing (e.g. no new category) is the top frustration.
4. "You already know this, so suggest it": paychecks, bill amounts, merchants.
5. Anything onboarding teaches must be reachable again later.
6. Generic merchants (Apple, Amazon, PayPal) cause the most tedium.
7. Show a number once, or compute it the same way everywhere.

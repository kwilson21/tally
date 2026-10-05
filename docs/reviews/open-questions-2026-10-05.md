# Open questions on the AI, Phase 5 and design-system issues (Oct 5)

Writing the issues for decisions 73–76 turned up 53 questions the spec doesn't answer. Each has a recommended answer, in the spirit of the owner's earlier picks: the simplest rule a person can say in a sentence, nothing hidden from the family, and no new script. The owner accepts them all, changes some, or goes through them one by one. Accepted answers become a decision entry and replace the "Open:" lines in the issues.

## AI (spec §8.6)

**AI: the AI suggestions switches in Settings (#AI1)**
1. *Where the switches live.* In the `household_settings` table that #189 adds (one row per switch), all on to start.
2. *Sort as they arrive, with Categories and Income both off.* It keeps its setting and simply has nothing to do; no extra words.
3. *Switching one back on.* Nothing special: transactions Tally never asked about while it was off are asked by the next nightly run, within the cap, as today.

**AI: Jev's income answer (#AI2)**
4. *Storing an answer below the threshold.* One nullable probability column per flag Tally may suggest: `income_confidence` and `transfer_confidence` (§5).
5. *Where "Maybe income" shows.* The same places as every "Maybe …": the dashed tag on the row, the edit panel (with "Tally's guess · N% sure"), and the review screen.
6. *Plaid says income, Tally disagrees.* Plaid's mark stands (it's the bank's own category); Tally never overrides it; a person overrides both.

**AI: sort new transactions right after each sync (#AI3)**
7. *Does Sync now ask Tally's AI too?* Yes. Decision 68 ("right after each sync") replaces §8.1's "not Jev, which stays nightly"; §8.1 is updated.
8. *The cap's window.* One cap per household day (midnight to midnight in the household's time zone), shared by sync and night.
9. *Pending transactions.* Asked like any other, so they don't sit in Spent; when the bank posts one, Tally's answer moves to it with the rest (§6).

**AI: Plaid's merchant name first (#AI4)**
10. *Names switch off.* No suggested names at all, Plaid's included; tidied names still show.
11. *Plaid's name equals the tidied name.* Nothing to suggest or review.
12. *One raw name, several Plaid names.* Suggest the most recent.

**AI: one review screen for every "Maybe …" (#AI5)**
13. *Which switch hides which.* Transfers and new categories follow Categories and exclusions; names follow Merchant names; income follows Income.
14. *A No.* Remembered for that transaction (for a name, that merchant), so it's never asked again.
15. *A Skip.* Stays in the count and comes back at the end.
16. *Order.* Money first: income and transfers, then categories and new categories, then names; newest first within each.
17. *Storing "Maybe a transfer".* The `transfer_confidence` column from 4.

**AI: what AI did this month (#AI6)**
18. *What counts.* Sorted: transactions Tally gave a category this month. Cleaned: merchants whose suggested name a person kept. Paychecks: income Tally set. Changed: any of those a person later changed (category, name or income).
19. *Early in a month.* This month's lines; until it has any, last month's, labelled with its name.
20. *A switched-off feature.* Its line says "Off" in muted words.

**AI: the demo's See it without AI (#AI7)**
21. *What the view takes away.* Everything Tally decided, including what it marked at sync from Plaid's categories: the list shows the bank's raw data only.
22. *Home's numbers.* Unchanged; only the list switches.
23. *"the card payment".* Reworded to match the seed's transfer to Savings; the seed and spec §9 stay as they are.

## Phase 5 (spec §8.4)

24. *#74's pace line (Home's top).* Close #74 as covered by the daily amount; no "cut back" line when over budget, which reads as blame (DESIGN.md voice).
25. *Nearly spent (budget rows).* 80% of the budget or more, and not over; written into §8.4.
26. *How Tally sends email (reconnect email).* Cloudflare's own email sending from the Worker, to family addresses verified in Cloudflare, so there's no new vendor or key; checked against Cloudflare's docs when built, as its own decision entry first.
27. *Every-two-weeks and quarterly keys.* A biweekly bill's `due_day` holds its anchor date's day of the week; `Qn` is the calendar quarter that holds the due date.
28. *Part paid.* "Part paid: $600 of $1,200" in whichever status group it would be in; the link picker sorts by closeness to what's left.
29. *A bill's category on its payment.* The edit panel says so in a muted line under the chips, "Category from the Rent bill", as it does for Tally's picks.
30. *Bills total.* Inactive bills don't count; a part-paid bill counts in full in the monthly total and by what's left in "still to pay".
31. *Amount history's first row.* Each existing bill's first `bill_amounts` row starts at its earliest linked payment's month, or this month if it has none.
32. *A price that goes down; the export.* "Price went down to $14.99 in October"; Download your data's JSON includes `bill_amounts` (and the other new tables).
33. *What counts toward the rule offer's three.* Transactions a person put in that category for that merchant, from any screen, counted from the transactions themselves (no new column); not "in a row".
34. *Type filter.* Refunds holds money in that isn't income or a transfer; a disconnected bank's accounts are listed, marked Disconnected.
35. *Search by amount.* "42.17" matches money out and money in.
36. *Likely transactions for a new category.* As drawn: this month and last, same merchant first, then Tally's guesses, newest first, up to 6.
37. *After Organize.* The edit panel only, for now.
38. *Rename one transaction.* A nullable `transactions.own_name`; the CSV's merchant column shows it when set.
39. *A renamed transaction's split parts.* They show its own name.
40. *The "Always for these merchants" list.* A–Z, with a search box once there are more than 20; in the panel, the toggle is unticked when the chosen category isn't the rule's (ticking it makes the new one the rule).
41. *Select all.* With All months it says "Select all 340 in all months"; unticking a row after selecting all leaves the rest selected ("111 selected").
42. *A cash entry that's split.* Its parts aren't edited one by one; a new date is copied to the parts, as for a bank's change; a new amount removes the split (§6.1).
43. *A cash entry with a linked bill payment or refund.* A new date keeps the links; a new amount is checked by the same guards (#181) and refused with a field error if it breaks one.

## Design system

44. *Amount controls (forms).* The split's parts and Plan an expense take the plain amount field, like bills and cash; only budgets keep MoneyInput.
45. *Forms with no sheet (Settings rows, Feedback).* Save at the end of the form, not pinned.
46. *An empty "Match payments from".* Stays closed and says "None yet · the first payment you link fills it in".
47. *The over-$100,000 chip.* Under the amount's alert line, as in P45 A.
48. *Which forms this issue covers.* The shared pieces, Add a bill and Add cash; every other form moves to the pattern with its own issue.
49. *The P74 drawing after motion ships.* It stays, drawn with the real motion classes.
50. *Older motions (bar fill, field shake, busy ring).* They move onto the same duration tokens.
51. *Desktop's side panel.* Slides in from the right in 200 ms, backdrop fading in.
52. *MoneyInput's corners.* They join the squircle rule when #80 settles its corners; until then they stay as they are.
53. *The P75 drawing after squircles ship.* It stays, with "Today" forced round so the comparison still shows.

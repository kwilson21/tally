# Open questions on the AI, Phase 5 and design-system issues (Oct 5)

**Answered on Oct 6 (decisions 79–82):** the owner went through every question by seeing a picture of each answer. Where the answer differs from the recommendation below, the Answers section at the end wins.

Writing the issues for decisions 73–76 turned up 53 questions the spec doesn't answer. Each has a recommended answer, in the spirit of the owner's earlier picks: the simplest rule a person can say in a sentence, nothing hidden from the family, and no new script. The owner accepts them all, changes some, or goes through them one by one. Accepted answers become a decision entry and replace the "Open:" lines in the issues.

## AI (spec §8.6)

**AI: the AI suggestions switches in Settings (#191)**
1. *Where the switches live.* In the `household_settings` table that #189 adds (one row per switch), all on to start.
2. *Sort as they arrive, with Categories and Income both off.* It keeps its setting and simply has nothing to do; no extra words.
3. *Switching one back on.* Nothing special: transactions Tally never asked about while it was off are asked by the next nightly run, within the cap, as today.

**AI: Jev's income answer (#192)**
4. *Storing an answer below the threshold.* One nullable probability column per flag Tally may suggest: `income_confidence` and `transfer_confidence` (§5).
5. *Where "Maybe income" shows.* The same places as every "Maybe …": the dashed tag on the row, the edit panel (with "Tally's guess · N% sure"), and the review screen.
6. *Plaid says income, Tally disagrees.* Plaid's mark stands (it's the bank's own category); Tally never overrides it; a person overrides both.

**AI: sort new transactions right after each sync (#193)**
7. *Does Sync now ask Tally's AI too?* Yes. Decision 68 ("right after each sync") replaces §8.1's "not Jev, which stays nightly"; §8.1 is updated.
8. *The cap's window.* One cap per household day (midnight to midnight in the household's time zone), shared by sync and night.
9. *Pending transactions.* Asked like any other, so they don't sit in Spent; when the bank posts one, Tally's answer moves to it with the rest (§6).

**AI: Plaid's merchant name first (#194)**
10. *Names switch off.* No suggested names at all, Plaid's included; tidied names still show.
11. *Plaid's name equals the tidied name.* Nothing to suggest or review.
12. *One raw name, several Plaid names.* Suggest the most recent.

**AI: one review screen for every "Maybe …" (#195)**
13. *Which switch hides which.* Transfers and new categories follow Categories and exclusions; names follow Merchant names; income follows Income.
14. *A No.* Remembered for that transaction (for a name, that merchant), so it's never asked again.
15. *A Skip.* Stays in the count and comes back at the end.
16. *Order.* Money first: income and transfers, then categories and new categories, then names; newest first within each.
17. *Storing "Maybe a transfer".* The `transfer_confidence` column from 4.

**AI: what AI did this month (#196)**
18. *What counts.* Sorted: transactions Tally gave a category this month. Cleaned: merchants whose suggested name a person kept. Paychecks: income Tally set. Changed: any of those a person later changed (category, name or income).
19. *Early in a month.* This month's lines; until it has any, last month's, labelled with its name.
20. *A switched-off feature.* Its line says "Off" in muted words.

**AI: the demo's See it without AI (#197)**
21. *What the view takes away.* Everything Tally decided, including what it marked at sync from Plaid's categories: the list shows the bank's raw data only.
22. *Home's numbers.* Unchanged; only the list switches.
23. *"the card payment".* Reworded to match the seed's transfer to Savings; the seed and spec §9 stay as they are.

## Phase 5 (spec §8.4)

24. *#74's pace line (Home's top, #199).* Close #74 as covered by the daily amount; no "cut back" line when over budget, which reads as blame (DESIGN.md voice).
25. *Nearly spent (budget rows, #200).* 80% of the budget or more, and not over; written into §8.4.
26. *How Tally sends email (reconnect email, #203).* Cloudflare's own email sending from the Worker, to family addresses verified in Cloudflare, so there's no new vendor or key; checked against Cloudflare's docs when built, as its own decision entry first. (Replaced by decision 86: Resend sends it first, with Cloudflare's email as the fallback.)
27. *Every-two-weeks and quarterly keys (#204).* A biweekly bill's `due_day` holds its anchor date's day of the week; `Qn` is the calendar quarter that holds the due date.
28. *Part paid (#205).* "Part paid: $600 of $1,200" in whichever status group it would be in; the link picker sorts by closeness to what's left.
29. *A bill's category on its payment (#206).* The edit panel says so in a muted line under the chips, "Category from the Rent bill", as it does for Tally's picks.
30. *Bills total (#207).* Inactive bills don't count; a part-paid bill counts in full in the monthly total and by what's left in "still to pay".
31. *Amount history's first row (#208).* Each existing bill's first `bill_amounts` row starts at its earliest linked payment's month, or this month if it has none.
32. *A price that goes down; the export (#208).* "Price went down to $14.99 in October"; Download your data's JSON includes `bill_amounts` (and the other new tables).
33. *What counts toward the rule offer's three (#209).* Transactions a person put in that category for that merchant, from any screen, counted from the transactions themselves (no new column); not "in a row".
34. *Type filter (#210).* Refunds holds money in that isn't income or a transfer; a disconnected bank's accounts are listed, marked Disconnected.
35. *Search by amount (#211).* "42.17" matches money out and money in.
36. *Likely transactions for a new category (#212).* As drawn: this month and last, same merchant first, then Tally's guesses, newest first, up to 6.
37. *After Organize (#212).* The edit panel only, for now.
38. *Rename one transaction (#213).* A nullable `transactions.own_name`; the CSV's merchant column shows it when set.
39. *A renamed transaction's split parts (#213).* They show its own name.
40. *The "Always for these merchants" list (#214).* A–Z, with a search box once there are more than 20; in the panel, the toggle is unticked when the chosen category isn't the rule's (ticking it makes the new one the rule).
41. *Select all (#215).* With All months it says "Select all 340 in all months"; unticking a row after selecting all leaves the rest selected ("111 selected").
42. *A cash entry that's split (#216).* Its parts aren't edited one by one; a new date is copied to the parts, as for a bank's change; a new amount removes the split (§6.1).
43. *A cash entry with a linked bill payment or refund (#216).* A new date keeps the links; a new amount is checked by the same guards (#181) and refused with a field error if it breaks one.

## Design system

44. *Amount controls (#217).* The split's parts and Plan an expense take the plain amount field, like bills and cash; only budgets keep MoneyInput.
45. *Forms with no sheet, Settings rows and Feedback (#217).* Save at the end of the form, not pinned.
46. *An empty "Match payments from" (#217).* Stays closed and says "None yet · the first payment you link fills it in".
47. *The over-$100,000 chip (#217).* Under the amount's alert line, as in P45 A.
48. *Which forms #217 covers.* The shared pieces, Add a bill and Add cash; every other form moves to the pattern with its own issue.
49. *The P74 drawing after motion ships (#218).* It stays, drawn with the real motion classes.
50. *Older motions: bar fill, field shake, busy ring (#218).* They move onto the same duration tokens.
51. *Desktop's side panel (#218).* Slides in from the right in 200 ms, backdrop fading in.
52. *MoneyInput's corners (#219).* They join the squircle rule when #80 settles its corners; until then they stay as they are.
53. *The P75 drawing after squircles ship (#219).* It stays, with "Today" forced round so the comparison still shows.

## Answers (decisions 79 and 80)

Recommended answers were taken unless listed here.

- **2:** greyed out, with "Needs Guess categories or Spot paychecks on"; and the four switches renamed (P86 A): "Suggest store names", "Guess categories", "Spot paychecks", "Sort right away", each with an example.
- **5:** P76 A, as recommended.
- **10:** the bank's own name is still offered with names off, and every name Tally guessed has a sparkles icon before it in the list, and the icon with "Tally's guess" in the edit panel and on the review screen (P87 B); the bank's says "From your bank".
- **14:** a No is remembered as a "Never suggest" rule, listed with "Always for these merchants" under "Tally's rules" in Settings, each with Remove (P88 A).
- **15:** a Skip comes back at the end; and Tally asks its AI again right away when a clearer name or a note is added to a transaction that still needs a category.
- **New (the owner's idea):** Tally fills in a transaction's details, dashed until kept: a clean name, what it was, its kind (subscription, one-off, bill or transfer) and who it was for, from a household people list, with a "Fill in details" switch (P89 A).
- **20:** P77 A, as recommended.
- **21–23:** as recommended, and the demo's links read "Tidied by Tally · Straight from the bank".
- **26:** Cloudflare's email (Resend is already set up if it's ever needed; decision 86 later put Resend first); the template is designed from emailcn's notification blocks (emailcn.run), written in Hono JSX with no new dependency.
- **28, 40, 41, 45, 46, 47, 51:** P78, P80–P85 A, as recommended.
- **29:** a Why? link beside Category explains it (P79 E), rather than a line under the chips.
- **33:** a store whose trips go in different categories (Costco: Groceries and Household) is never offered an "always" rule (a person can still tick Always themselves). Tally guesses one category from the trip's details, or, when the details point to more than one, suggests a split with the categories filled in and the amounts left to the person (P90, A combined with B). Rule offers stay for stores with one category.
- **38:** the CSV gets its own `own_name` column, next to the store's name.
- **42:** a new date moves a split cash entry's parts; a new amount that no longer matches its parts can't be saved until the parts are corrected ("The parts add up to $90.00. Change them to match $100.00."). The split is never reset.
- **48:** decided as recommended (it's how the work is split into pull requests).

## Two more, from P89 (decision 81)

- **54:** a kind (subscription, one-off, bill or transfer) is a word about the purchase and never changes a number; Exclude and Bills work as before (A, as recommended).
- **55:** removing a person from the people list clears them from the purchases marked for them, and the toast says how many (A, as recommended).

## More, from #198–#203 and #207 (decision 82)

The owner answered these on Oct 6 by seeing a picture of each, so they have no recommended answer above; the drawings are P91–P109 on the proposals page. Numbering continues from 55.

**Browse past months (#198)**
56. *Does a finished month's number take off its savings goal and plans?* No: it is the month's budgets minus its spending, and the goal and plans don't change it (P91).
57. *The words for a month with no budgets, exactly $0, every category over, or three or more over.* There is no sentence to word: a tilted Under or Over stamp says how it ended (exactly $0 reads Under, as P46 A drew it), and the bars show every category that went over, however many (P91).
58. *A month outside the range.* Any other month in the address, a future one or one before the first with transactions, opens this month; a strip of month dots runs from the first month to now (P92).
59. *Does a finished month list its Not budgeted categories?* Yes, each with what it spent, read-only like its other rows (P93).

**Home's top (#199)**
60. *Where Why? goes below $0.* The label stays, because the number now shows as negative ("−$40"), so Why? sits beside "Safe to spend" as before (P94).
61. *The daily line on the last day, and when it rounds to 0¢.* The picked daily amount remains through day 6 while the forecast waits for a week of pace (decision 95). It is omitted when Safe to spend is $0 or less; on the last day, the forecast is already shown (P95).
62. *The order of this line and the stale-bank line.* The bank line comes first, then the forecast; the bank line keeps its job and gets a dashed "as of Oct 2" tag and a soft brick-tinted line with a Fix button, and no playful words (P96).
63. *A headline just below $0.* "−$0.40": cents show only when the amount is under $1 (P94).
64. *The words for exactly one older transaction.* The Band reads "12 need a category" with a small "+1 older" chip (P97).

**Budget rows (#200)**
65. *A $0 budget with nothing spent.* No warning (P98).
66. *"$X left" on a finished month's rows.* No: a finished row reads "spent / budget" with a bar, and nearly spent is now an amber bar at 80% or more, so there is no "left" (P93, P98).
67. *A category where refunds outweigh spending (gap E9).* "+$20" in green with an empty bar, and the same on a Not budgeted row (P98).
68. *Excluded transactions in the sheet's list, and its link.* Excluded transactions aren't counted; the link is a "12 transactions ›" button, shown only when there are some (P99).

**A savings goal (#201)**
69. *Can a goal be taken away?* Yes: setting it to $0 from a month on removes it, and it goes back under Not budgeted as "Set a goal" (P100).
70. *Do Adjust's − and + apply to the Savings row?* No: only its sheet changes it (P100).
71. *Does a finished month's number take off its goal?* No, as in 56.

**Planned expenses (#202)**
72. *A category on a plan.* No category: a linked payment keeps its own, and `category_id` leaves §5.
73. *Which transactions the picker lists.* Money out from the plan's month and the next, not already paying a bill or a plan, closest amount first (P101).
74. *Editing, deleting, unlinking, where a paid plan shows, totals.* The plan's own sheet edits it, deletes it and unlinks a payment (P102); once paid it shows with the paid bills, with a check (P103); the Planned group shows its own total, and plans aren't in the monthly bills total (P104).
75. *An excluded payment.* It can be linked and counts once linked, the same rule as for bills.
76. *The Band with two actions, and with two unpaid plans.* It asks about one plan at a time: "Car registration wasn't paid", with Move to Nov and Drop, and a dot for each plan waiting (P105).

**The reconnect email (#203)**
77. *Where "everyone in the family" comes from.* Everyone who has signed in to Tally in the last 90 days: Tally notes each verified sign-in address the first time it sees it and updates it at each sign-in (a new `household_members` table with `email`, `first_seen_at` and `last_seen_at`). Nothing else needs confirming: Resend sends it (decision 86, which replaces the Cloudflare Email Routing verification this answer first had). Settings lists each address with Remove for anyone in the family, so a person who has left stops getting it; a removed address comes back only if that person signs in again, which needs Cloudflare Access.
78. *Whole household or per person, and On or Off to start.* One household switch, "Bank sign-in emails", on to start, with the people shown as initials (P107).
79. *When the first email goes.* At the nightly run after a bank needs attention, then every 3 days until it's fixed (P108).
80. *Where "when the last one went" is kept.* A nullable column on `plaid_items` (`reconnect_emailed_at`), listed in §5.
81. *The footer's "Turn these emails off" link.* Dropped: the email says "Turn off in Settings" in muted words, with no link, and has one button, "Open Accounts" (P109).

**The bills total (#207)**
82. *Does a part-paid bill add its full amount or what's left to its group's total?* What's left. The monthly total still counts it in full (decision 79) (P106).

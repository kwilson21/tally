# Store lookup: a web search behind each new store

Status: approved by the owner in chat on 2026-11-12, with the three choices below settled as proposed. In the spec as §7 "Store lookup" and decision 210.

## What it is, in one sentence

The first time Tally sees a store's bank text, it searches the web for it once, keeps one short line about what the store is ("Coffee shop in Arlington, VA"), and tells Jev and the name run that line.

## Why

"LA COOP ARLINGTON Arlington VA" was guessed as "Maybe Groceries" at 61%. It is a coffee shop. The bank text was enough for a web search to say so, and nothing Tally sends its models today could. The owner's words: the search "would add even more to the name generation, the category suggestion would be much more accurate".

## Goals

- Jev's category answer and Workers AI's name suggestions get one more fact: what the store is.
- A person sees that fact on the card, so the guess explains itself.
- Each store is searched once, ever.

## Non-goals

- No agent, no chat, no LangChain or LangGraph. The bank text is already the right query, so nothing needs to decide what to search (owner agreed 2026-11-12).
- No model that decides whether a search is worth it. A search costs about half a cent and happens once a store; rules in code decide (owner agreed 2026-11-12).
- Nothing runs while a page loads. The lookup runs where Jev and the name run already do.
- Receipts (`src/ai/read-receipt.ts`) are untouched.

## Anti-goals (a failure even if it works)

- A person's name, an amount, a date or an account name reaching the search company.
- The lookup line being treated as an instruction by Jev or Workers AI.
- A search failure holding up sorting. A store with no lookup sorts exactly as it does today.
- The lookup deciding anything. It is context for a suggestion; people still decide.

## Approaches considered

1. **Look each store up once, keep the answer (picked).** A search by plain fetch, Workers AI condenses the results to one line, the line is stored against the merchant and passed to the existing runs. Fits the two-provider rule for models, adds one small module and one table.
2. **A model with search built in.** One call searches and answers. Less code, but it adds a third model provider beside Jev and Workers AI, which CLAUDE.md keeps to two.
3. **An agent that decides when and what to search** (the first idea, with LangGraph). It would be the first AI to run on a page load, adds a large dependency, and the choice it would make is already made by the bank text.

The owner picked 1 in chat on 2026-11-12.

## How it works

### The steps

1. A merchant row exists with no lookup (new from a sync, or from before this shipped).
2. The lookup run asks the code rules below whether this store may be searched.
3. If yes: one `fetch` to the search service with the redacted bank text as the query.
4. Workers AI reads the top results and answers with one line of at most 80 characters saying what kind of place it is and where, or "nothing found".
5. The line (or "nothing found") is stored against the merchant. It is never searched again.
6. When Jev is asked about a transaction of that merchant, the line is one more field of `JevInput`. When Workers AI is asked for a merchant's names (`suggestNames`, only for stores Plaid did not name, at night after sorting), the line is given too. The new-category name (`suggestCategoryName`) and the note line are not changed, and names already asked are not asked again.

### When it runs

In the same places sorting runs (spec §7): the night's Workflow and right after a sync, as a step **before** Jev and the name run, so the line is there when they ask. Never in a request a person is waiting on.

Stores that already exist when this ships are looked up by the same run, oldest first, under the daily cap, so the backlog drains over a few nights.

**Rows already guessed (the owner picked re-asking, 2026-11-12):** a line only helps a row asked after the line exists. Without more, the Maybes waiting today (la coop among them) and any first-import store sorted before its lookup landed would keep their old guess. When a store's lookup lands as `found`, Jev is asked again about that store's rows that are still uncategorized or an unanswered Maybe, within Jev's daily cap, as decision 157 does after a new category. Rows a person answered, and rows a rule filed, are never re-asked.

### When a store is not searched (code rules, no model)

Checked in this order; the first that applies wins:

1. **Private:** stored as `skipped`, never searched. This rule is about privacy, not cost: "ZELLE TO JANE DOE" never leaves the app, and `redactBankTextForAi` drops numbers, not names. A store is private when any of these holds:
   - any of its transactions has one of Plaid's transfer categories (`TRANSFER_CATEGORIES` in `src/db/plaid-transfers.ts`) or Plaid's income category, or a person marked one a transfer;
   - its text starts with a payment app's name, from a short list in code (Venmo, Zelle, Cash App, PayPal, Apple Cash, and the like). This is the net for rows with no Plaid category: Apple Card CSV rows and any other import store none (`src/plaid/sync.ts` is the only writer of `plaid_category`);
   - it has only cash, hand-entered or Apple Card CSV transactions. The name run already leaves these out (`src/db/merchant-names.ts`), and the lookup follows it (my call, the cautious one: Apple Card rows carry no Plaid category to check);
   - the redacted text is empty.

   **Not a store** is skipped the same way: a text whose transactions carry Plaid's bank-fees category (`BANK_FEES`: fees and interest charges). A web search has nothing to say about these (the owner's pick, 2026-11-12, after a read of production found 12 of its 30 candidate texts were bank fees).
2. **Already settled:** the merchant has a merchant rule or a bank-text rule. Left as `none`; it is searched later only if the rule is removed. A rule only stops the search: a line found before the rule was made is kept and still shown.
3. **Already looked up:** `found`, `nothing_found` or `skipped`.
4. **Cap reached:** left as `none` for the next run.

Everything else is searched. Stores Plaid already names are searched too (the owner's pick, 2026-11-12). Workers AI is only asked for names when Plaid sends none (decision 68), so for a Plaid-named store the line helps Jev's category only, not the name. Searching them roughly doubles the searches; skipping them means a store Plaid names but Jev misfiles gets no help.

### The states (the rule, stated once)

This follows the app's rule styles (decision 206). The owner noted these rules read like XState and Effect logic; here is where each fits.

- **Style 1, XState alone:** a new machine `src/machines/store-lookup.ts`, the one place the rule is stated, like `jev-retry.ts` and `merchant-suggestion.ts`. The SQL writers keep the column in step and a test walks every writer against the machine.

```
none     --private-->        skipped         Plaid says transfer or person-to-person, or nothing left to send
none     --found-->          found           the search gave a usable line
none     --nothing found-->  nothing_found   the search answered, with nothing usable
none     --failed-->         none            attempts + 1; the next run tries again
none     --failed (cap)-->   gave_up         failed LOOKUP_ATTEMPT_CAP times in a row
found    --person removes--> skipped         "Don't use this" on the card (see below)
```

- **Not style 2 (the bridge):** the search is outside work, but the job is long and already has a home. Decision 209 point 3 sends a long wait on an outside service to the existing Workflow, so the search is a Workflow step and the machine only states the moves.
- **Not style 3 (Effect) for the run:** decision 206 keeps Effect style for write handlers; the lookup run is background work like sync and stays plain TypeScript.
- **Style 3 for the one write a person makes:** "Don't use this" on a lookup line is a write handler, so it is a `rule({...})` from `src/rules/terms.ts`, with an entry in `docs/write-handlers.json`.
- **`Schema` at the edge:** the search service's JSON is decoded with Effect `Schema` once, in the lookup module (decision 206).

### What leaves the app

- **To the search service:** the store's **lookup text**: the merchant key (`merchants.raw_name`: Plaid's `merchant_name` when the transaction has one, otherwise the bank's raw text, spec §6.1) after `cleanBankText` and `redactBankTextForAi` (decision 164: numbers, amounts and phone numbers dropped, 40 characters), and nothing else. No amount, date, account, household or user identifier. An instruction-like text is never sent (`bankTextToSend`'s check).
- **To Workers AI (already a provider):** the same redacted text and the search results' titles and snippets.
- **To Jev:** one new optional `JevInput` field, `storeLookup`, holding the stored line.

Search results are text from the open web, so the stored line is treated as untrusted: it is capped at 80 characters, stripped to letters, numbers and basic punctuation, dropped if it reads as an instruction (the existing check), and given to Jev and Workers AI as a labelled fact, never as part of their instructions.

### The search service

**Tavily** (the owner's pick, 2026-11-12; Brave was my first proposal). One `POST https://api.tavily.com/search` with a JSON body, so the query never sits in a URL, and the key in an `Authorization: Bearer` header. Reported at 1,000 free credits a month and about $0.008 a basic search after that. The price, the request fields and the rate limit (reported as 20 requests a minute) are from secondary sources; the builder confirms them on Tavily's own API reference before building (CLAUDE.md: never from memory).

**Tavily's terms, read on 2026-11-12** (privacy policy last updated 2025-11-24): it collects query data, may use parts of it to improve its answers, may share a query with other search index providers when its own index can't answer, and states no retention period. Its account setting "Allow Use of Query Data", when off, means query data "will not be stored or used for improvements". The owner turns that setting off before the production key is set (decision 210). Only redacted store text is sent and private payments are skipped either way.

All search calls go through one module, `src/ai/lookup-store.ts`, with one function signature, as Jev does through `categorize.ts`. Changing services changes only that file. The Workers AI call that writes the one line lives there too, so CLAUDE.md's "Workers AI only via" list gains this file.

### Storage

A new table (one migration), kept apart from `merchants` as `merchant_name_failures` is:

`merchant_lookups`: `lookup_text` (primary key: the redacted text that is sent, see "What leaves the app"), `status` (`found`, `nothing_found`, `skipped`, `gave_up`, or `pending` for a store a run has claimed or is to try again), `line` (null unless `found`), `attempts`, `claimed_at`, `failed_at`, `looked_up_at`, `reasked_at`. No row means `none`.

`lookup_answers`: `transaction_id` (primary key), `lookup_text`. One row for each transaction whose stored Jev answer was asked with the line.

Four rules the review of the plan added (PR #997):
- **Claim before calling.** A run claims a store in the table before it searches, and searches only what it claimed, so two runs at once make one search.
- **Count every search.** The day's cap is a counter of its own, taken before the calls as Jev's is, not worked out from the rows' last timestamps.
- **Privacy is checked on the merchant key as stored**, before cleaning and the 40-character cap (the cleaner strips "PAYPAL *"), and when several merchants share one lookup text, one private merchant makes the text private.
- **A line is shown only under a guess that used it**, and the re-ask skips rows already asked with the line and waits while the switch is off.

The key is the lookup text, not the merchant key, because an unnamed store's merchant key is its raw text with the date in it (`src/db/merchant-key.ts`): "LA COOP … 07/24" and "… 07/25" are two merchant rows and one lookup text, so the store is still searched once. A merchant finds its lookup through a stored `merchants.lookup_text` column, which the lookup run fills, since the text is computed in TypeScript and SQL cannot join without it. `merchant_lookups.reasked_at` marks a found store whose open guesses have been asked again, so the re-ask is driven by stored state, covers stores looked up on earlier nights, and gives new rows Jev's cap first. A chain Plaid names ("Target") is one lookup for every branch, so the summary says where a place is only when the results agree on one place.

No search results or URLs are stored, and none are logged (CLAUDE.md: never log transaction details).

### Limits and switches

- `STORE_LOOKUP_DAILY_CAP`: 300 a household day in production, 0 in the demo. Its own cap, not Jev's.
- `LOOKUP_ATTEMPT_CAP`: 3 failures in a row, then `gave_up`.
- A new AI switch in Settings → AI suggestions, "Look up new stores on the web", beside the existing ones, on by default. Off means off: no searches, no summary calls, and stored lines are neither sent to Jev or Workers AI nor shown, until it is turned on again. The lines stay stored.
- One new secret, `TAVILY_API_KEY`, production only, set by the owner with `wrangler secret put`. It is set only after the measurement has reported and the Settings switch has shipped, so nothing is sent before then.

### The demo

The demo never searches and gets no key. Its seed holds a few stored lookups (the la coop coffee shop among them), so the card and the better guess show right after the nightly reset.

### What a person sees

On a card whose guess had a lookup line, one more line of reason:

```
la coop
LA COOP ARLINGTON Arlington VA 07/24
$5.83 · Jul 24

( Maybe Eating Out )

Tally's guess · 88% sure   Why?
Looked up: coffee shop in Arlington, VA     Don't use this

[ Yes, Eating Out ]
```

"Don't use this" drops the line for that store for good (state `skipped`) and is announced through the usual toast. "How Tally works" gains a short section the Why? link can point to, and "What AI did" needs no new count, since a lookup applies nothing by itself.

This is a new visual choice. Per DESIGN.md it starts in the catalog: the line as a component, the owner's sign-off there, then the app pages (the suggestions card and the transaction edit panel). The exact words and placement are the owner's to pick from pictures at that step, not settled here.

## What the owner decided, and what are my calls

Owner, in chat on 2026-11-12:
- Web search added to the existing Jev and Workers AI runs, not a live agent.
- Look each store up once and keep the answer.
- No decision model as a gate; code rules instead.

- Tavily is the search service, with its "Allow Use of Query Data" setting turned off before the production key is set (decision 210).
- Rows still uncategorized or an unanswered Maybe are asked again when their store's lookup lands.
- Stores Plaid already names are searched.
- No Quint for the lookup itself; a scratch Quint model of the re-ask before it is built (below).

My calls, open to correction:
- The payment-app list, and leaving out cash and Apple Card rows, as the privacy net for rows with no Plaid category.
- One lookup per lookup text, so a chain shares one line.
- The switch off hides and withholds stored lines as well as stopping searches.
- "Don't use this" re-asks that store's open guesses only if the owner picks re-asking above.
- The caps (300 a day, 3 attempts), the 80-character line, the switch on by default.
- The "Looked up:" line and "Don't use this" on the card, pending the catalog step.
- XState style 1 for the lookup's states; Workflow step for the search; Effect only for "Don't use this".

## Left to the builder

- The exact Tavily request and response fields, from Tavily's current API reference. Tavily can return its own written answer; it is not used, so the one line always comes from Workers AI and goes through the same cleaning.
- The Workers AI prompt for the one-line summary, and which of the existing models writes it.
- The payment-app names in the private list, checked against the bank texts in the demo seed and tests.
- How the lookup step is ordered inside `src/sort-workflow.ts` and the after-sync run.
- Measuring it, in two steps, both through a never-deployed script like `scripts/compare-models/`. First, before anything else is built: Jev on the demo seed with and without hand-written lines, to see whether a correct line helps at all. Second, after the lookup code exists and before the key reaches production: real Tavily searches and real summaries, run locally with the owner's key, on 20 to 30 real store texts the owner picks, reporting how many lines are right and how Jev's answers change. Either step can stop the work.

## Design-time check for the re-ask (docs/verification.md, "Quint")

Before the re-ask is built, a scratch Quint model, not committed and not run in CI: the events "lookup lands", "person answers the card", "rule added", "re-check running" and "re-ask runs" in any order, checking that a row a person answered or a rule filed is never changed and that Jev's daily cap is never passed. What it finds goes into the tests.

## What changes in the repo's own documents

- Spec §7: a "Store lookup" part (when it runs, what is sent, the states), §4's secrets and environment tables, §5's table list.
- `docs/decisions.md`: one new entry (the next free number, checked against main and open PRs): a web search service joins as a third outside AI-adjacent call, what is sent to it, the retention accepted, and no new dependency.
- CLAUDE.md's AI rule: "web search only via `src/ai/lookup-store.ts`", and that file added to the Workers AI list.
- DESIGN.md and the catalog: the lookup line component.

## Size

A project, in three PRs that each stand alone: (1) the lookup module, table, machine and run, with nothing shown; (2) the line passed to Jev and the name run, with the measurement; (3) the card line, the switch and "Don't use this", after the catalog sign-off.

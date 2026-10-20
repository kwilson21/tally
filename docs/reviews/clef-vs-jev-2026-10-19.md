# Clef against Jev: the measurement behind decision 140

- **Date:** 2026-10-19
- **Issue:** #729, from decision 136. The Worker came in with #742.
- **Ran from:** commit `f8563451`, squash-merged as `1dd0e5ed`, with `scripts/compare-models/`. It made 216 calls in 73 s, with demo data only.
- **Outcome:** Jev stays (decision 140). Decision 9 is unchanged.

## What was measured

Tally's own call (`askJev` in `src/ai/categorize.ts`, unchanged) went to three models:
- Jev
- Clef (`@cf/cloudflare/clef`)
- Clef-flash (`@cf/cloudflare/clef-flash`)

Each answer was scored by `decide` (`src/ai/decide.ts`) at Tally's 0.80 cutoff, so "applied" means what Tally would store.

**The cases:** 36 of them, one for each raw bank name and direction in the demo seed. They were asked as a new family's first sync would ask them: no store history, no chosen names and no Plaid category. Split rows and cash rows were skipped.

**The right answer:** the demo's own category, the one each transaction was designed with. The demo's unsure rows and its income, transfer and reimbursement rows have no right category; their flags are what was checked.

**Two category lists:**
- the demo's 7
- 50, decision 37's most: the demo's 7, the 9 starting categories the demo lacks, and 34 more

## What it found

- **Tally's call works on Clef unchanged.** All 36 answers from each model were readable, in both lists. Clef's published output fields (`choice`, `confidence`, `noul`) are the ones Tally's parser reads.
- **Clef picks about as well as Jev.** Each model's pick matched the demo's category this many times, at any confidence:

  | | With 7 categories | With 50 |
  |---|---|---|
  | Jev | 13 | 12 |
  | Clef | 13 | 11 |
  | Clef-flash | 10 | 11 |

  With 50 categories, Jev and Clef mostly pick the same thing: Shopping for Target, Pharmacy for CVS, Gym for the gym, Streaming for Netflix.
- **Clef is much less sure of its picks.** Middle confidence:

  | | With 7 categories | With 50 |
  |---|---|---|
  | Jev | 91% | 96% |
  | Clef | 41% | 37% |
  | Clef-flash | 40% | 25% |

  Clef's confidence comes from its probabilities across every option, so it spreads thinner as the list grows.
- **At Tally's 0.80 cutoff, Clef would sort almost nothing.** Transactions each model would put a category on:

  | | With 7 categories | With 50 |
  |---|---|---|
  | Jev | 14 | 27 |
  | Clef | 6 | 0 |
  | Clef-flash | 0 | 0 |

  None of Clef's applied picks were wrong. Jev's 7 "wrong" picks with 50 categories are mostly better fits than the demo's own category: Shopping, Books, Home Repair, Streaming and Gym.
- **Flags** (transfer, reimbursement, income):

  | | With 7 categories | With 50 |
  |---|---|---|
  | Jev | 3 of 3 | 3 of 3 |
  | Clef | 2 of 3 (missed the doctor's refund as a reimbursement) | 3 of 3 |
  | Clef-flash | 1 of 3 | 2 of 3 |

  No model raised a flag it shouldn't have.
- **Speed:** middle times from this machine were 131 ms for Jev, 287 ms for Clef and 363 ms for Clef-flash. Clef's times include Wrangler's remote-binding hop, so they are rough.
- **Size and cost:** Jev's first call used 925 input tokens, and Clef's used 1,197. At the input prices found on Oct 19 ($0.042 per million for Jev, from Better Stack's comparison; $0.240 for Clef and $0.038 for Clef-flash, from Cloudflare's changelog), a night's 500-call cap costs about $0.02 on Jev, $0.14 on Clef and $0.02 on Clef-flash.

## Why Jev stays

Switching to Clef would need a new confidence cutoff, or Tally would stop sorting. Setting one safely would take far more than 36 cases. Clef's main draw, one fewer outside company and secret, doesn't outweigh that. Jev is also as good or better here on picks, flags and speed.

## How far this evidence goes

- 36 invented cases show how each model behaves. They don't rank the models' accuracy on a real family's mix.
- The demo's rows carry no Plaid category, which real rows do and which Jev uses as a hint.
- With 50 categories, some picks that count as "wrong" fit better than the demo's own category, so the per-case table matters more than the count.
- Clef is weeks old, and Cloudflare changed it once in its first ten days. A later version may score its confidence differently.

## Measuring again

From a checkout of `main`:
1. Start the Worker. The env file needs `JEV_API_KEY`, the path must be absolute, and the run needs `wrangler login`:

   ```bash
   npx wrangler dev --config scripts/compare-models/wrangler.jsonc --env-file /Users/kazon/repos/tally/.dev.vars --port 8799
   ```

2. Fetch the report:

   ```bash
   curl -s http://localhost:8799/
   ```

Wrangler's log must say "Using secrets defined in" with the `.dev.vars` path, and must not say "Missing required secrets". A run costs under $0.25, and `?model=…&list=…` runs one slice.

## The full report (as the Worker printed it)

### Clef and Jev on the demo seed

Date: 2026-10-19. Cases: 36, one per raw name and direction.
Jev: ran.

The demo's rows carry no Plaid category, which real rows do.
Times are measured from this machine through wrangler dev.

#### The demo's 7 categories

| Model | Calls that worked | Right | Right pick at any confidence | Wrong | Left (none fit / unsure) | Applied with no right answer | Flags (hit / false alarm / missed) | Mixed and note answered | Confidence (low / middle / high) | Time in ms (middle / slowest) |
|---|---|---|---|---|---|---|---|---|---|---|
| Jev | 36 of 36 | 11 | 13 | 0 | 18 / 4 | 3 | 3 / 0 / 0 | 36 | 30.00% / 91.00% / 100.00% | 131 / 405 |
| Clef | 36 of 36 | 6 | 13 | 0 | 15 / 15 | 0 | 2 / 0 / 1 | 36 | 15.83% / 40.80% / 92.62% | 287 / 624 |
| Clef-flash | 36 of 36 | 0 | 10 | 0 | 21 / 15 | 0 | 1 / 0 / 2 | 36 | 11.22% / 40.34% / 78.61% | 363 / 494 |

| Raw name | Direction | The demo's category | Jev | Clef | Clef-flash |
|---|---|---|---|---|---|
| TRADER JOE'S #552 | money out | Groceries | Groceries 100.00% ✓ | Groceries 72.09% | Groceries 23.92% |
| COSTCO WHSE #0431 | money out | Groceries | Groceries 90.00% ✓ | Groceries 62.23% | None of these fit 19.02% |
| WHOLEFDS MKT 10233 | money out | Groceries | Groceries 99.00% ✓ | Groceries 75.52% | None of these fit 22.62% |
| BLUE BOTTLE COFFEE | money out | Eating Out | Eating Out 90.00% ✓ | Eating Out 66.82% | Eating Out 22.87% |
| CHIPOTLE 2291 | money out | Eating Out | Eating Out 99.00% ✓ | Eating Out 91.22% ✓ | Eating Out 49.14% |
| OLIVE GARDEN 1187 | money out | Eating Out | Eating Out 100.00% ✓ | Eating Out 92.33% ✓ | Eating Out 56.66% |
| SHELL OIL 57442 | money out | Gas | Gas 100.00% ✓ | Gas 91.35% ✓ | Gas 64.29% |
| CHEVRON 0098812 | money out | Gas | Gas 100.00% ✓ | Gas 92.62% ✓ | Gas 62.99% |
| TARGET T-1432 | money out | Kids | Groceries 30.00% | Groceries 31.72% | Groceries 11.73% |
| YOUTH SOCCER LEAGUE | money out | Kids | Kids 99.00% ✓ | Kids 67.82% | Kids 44.72% |
| BARNES & NOBLE #2831 | money out | Kids | None of these fit 84.00% | None of these fit 22.32% | None of these fit 31.29% |
| THE HOME DEPOT #6612 | money out | Household | Household 56.99% | Household 35.05% | None of these fit 18.72% |
| AMAZON.COM*RT4K2 | money out | Household | None of these fit 68.99% | None of these fit 15.83% | None of these fit 29.80% |
| ACME CORP PAYROLL | money in | a person decides | None of these fit 98.00%, flags: income | None of these fit 38.08%, flags: income | None of these fit 78.61%, flags: income |
| ONLINE TRANSFER TO SAV ...5678 | money out | a person decides | None of these fit 95.00%, flags: transfer | None of these fit 26.50%, flags: transfer | None of these fit 50.44% |
| MARIO'S PIZZA | money out | Eating Out | Eating Out 100.00% ✓ | Eating Out 89.73% ✓ | Eating Out 59.31% |
| SQ *LOCAL BAKERY 4432 | money out | a person decides | Groceries 76.00% | Eating Out 53.08% | Groceries 23.61% |
| PAYPAL *XYZSHOP | money out | a person decides | None of these fit 95.00% | None of these fit 33.77% | None of these fit 51.70% |
| SQ *FARMERS MKT | money out | a person decides | Groceries 100.00% ✓ | Groceries 72.57% | Groceries 56.04% |
| VENMO *J RIVERA | money out | a person decides | None of these fit 97.00% | None of these fit 31.39% | None of these fit 49.93% |
| TST* CORNER DELI | money out | a person decides | Eating Out 86.00% ✓ | Eating Out 55.31% | Eating Out 64.39% |
| AMZN MKTP US*2K4 | money out | a person decides | None of these fit 74.00% | None of these fit 18.30% | None of these fit 27.08% |
| SP * CRAFTSUPPLY | money out | a person decides | None of these fit 77.00% | Household 23.08% | None of these fit 14.02% |
| POS 4417 CITY PARKING | money out | a person decides | None of these fit 78.00% | None of these fit 26.35% | None of these fit 35.98% |
| CHECKCARD 0921 CVS | money out | a person decides | None of these fit 60.00% | Household 26.81% | None of these fit 22.54% |
| APPLE.COM/BILL | money out | Household | None of these fit 92.00% | None of these fit 16.71% | None of these fit 31.46% |
| GOOGLE *YOUTUBE | money out | a person decides | None of these fit 94.00% | None of these fit 20.92% | None of these fit 58.76% |
| DD *DOORDASH TACO | money out | a person decides | Eating Out 99.00% ✓ | Eating Out 76.55% | Eating Out 60.04% |
| DR MARTIN FAMILY PRACTICE REFUND | money in | a person decides | None of these fit 90.00%, flags: reimbursement | None of these fit 43.52% | None of these fit 56.36% |
| GOOGLE *YOUTUBE PREMIUM | money out | Household | None of these fit 89.00% | None of these fit 26.93% | None of these fit 45.29% |
| PROCREATE DREAMS | money out | Household | None of these fit 95.00% | None of these fit 17.22% | None of these fit 17.13% |
| CITY GYM MEMBERSHIP | money out | Household | None of these fit 84.00% | None of these fit 48.66% | None of these fit 29.32% |
| TARGET T-1432 | money in | Kids | None of these fit 44.00% | Groceries 32.99% | None of these fit 11.22% |
| LITTLE SPROUTS DAYCARE | money out | Childcare | Childcare 100.00% ✓ | Childcare 87.82% ✓ | Childcare 74.79% |
| HARBOR PROPERTY MGMT | money out | Rent | Rent 63.00% | Rent 67.02% | Rent 69.09% |
| NETFLIX.COM | money out | Household | None of these fit 81.00% | None of these fit 26.93% | None of these fit 27.64% |

#### The 50 categories

| Model | Calls that worked | Right | Right pick at any confidence | Wrong | Left (none fit / unsure) | Applied with no right answer | Flags (hit / false alarm / missed) | Mixed and note answered | Confidence (low / middle / high) | Time in ms (middle / slowest) |
|---|---|---|---|---|---|---|---|---|---|---|
| Jev | 36 of 36 | 10 | 12 | 7 | 3 / 6 | 10 | 3 / 0 / 0 | 36 | 46.00% / 96.00% / 100.00% | 118 / 279 |
| Clef | 36 of 36 | 0 | 11 | 0 | 1 / 35 | 0 | 3 / 0 / 0 | 36 | 7.60% / 37.41% / 79.17% | 404 / 863 |
| Clef-flash | 36 of 36 | 0 | 11 | 0 | 6 / 30 | 0 | 2 / 0 / 1 | 36 | 2.24% / 24.75% / 73.91% | 621 / 743 |

Some of the 50 names fit these stores as well as the demo's own category does, so read the picks, not just the count.

| Raw name | Direction | The demo's category | Jev | Clef | Clef-flash |
|---|---|---|---|---|---|
| TRADER JOE'S #552 | money out | Groceries | Groceries 100.00% ✓ | Groceries 65.23% | Groceries 14.00% |
| COSTCO WHSE #0431 | money out | Groceries | Groceries 73.00% | Groceries 38.16% | Groceries 7.38% |
| WHOLEFDS MKT 10233 | money out | Groceries | Groceries 97.00% ✓ | Groceries 67.30% | None of these fit 5.36% |
| BLUE BOTTLE COFFEE | money out | Eating Out | Eating Out 81.00% ✓ | Eating Out 49.63% | Eating Out 14.91% |
| CHIPOTLE 2291 | money out | Eating Out | Eating Out 99.00% ✓ | Eating Out 72.07% | Eating Out 23.66% |
| OLIVE GARDEN 1187 | money out | Eating Out | Eating Out 100.00% ✓ | Eating Out 77.56% | Eating Out 40.71% |
| SHELL OIL 57442 | money out | Gas | Gas 97.00% ✓ | Gas 72.21% | Gas 30.83% |
| CHEVRON 0098812 | money out | Gas | Gas 97.00% ✓ | Gas 69.48% | Gas 25.84% |
| TARGET T-1432 | money out | Kids | Shopping 90.00% ✓ | Shopping 21.54% | Shopping 44.11% |
| YOUTH SOCCER LEAGUE | money out | Kids | Kids 93.00% ✓ | Hobbies 15.79% | Kids 18.69% |
| BARNES & NOBLE #2831 | money out | Kids | Books 99.00% ✓ | Books 36.30% | Books 16.34% |
| THE HOME DEPOT #6612 | money out | Household | Home Repair 95.00% ✓ | Home Repair 36.94% | Home Repair 29.83% |
| AMAZON.COM*RT4K2 | money out | Household | Shopping 93.00% ✓ | Shopping 32.77% | Shopping 28.34% |
| ACME CORP PAYROLL | money in | a person decides | None of these fit 99.00%, flags: income | Allowance 25.42%, flags: income | None of these fit 27.96%, flags: income |
| ONLINE TRANSFER TO SAV ...5678 | money out | a person decides | None of these fit 93.00%, flags: transfer | None of these fit 7.60%, flags: transfer | None of these fit 17.28% |
| MARIO'S PIZZA | money out | Eating Out | Eating Out 99.00% ✓ | Eating Out 71.50% | Eating Out 22.11% |
| SQ *LOCAL BAKERY 4432 | money out | a person decides | Groceries 88.00% ✓ | Groceries 37.90% | Eating Out 19.38% |
| PAYPAL *XYZSHOP | money out | a person decides | Shopping 89.00% ✓ | Shopping 36.19% | Shopping 38.62% |
| SQ *FARMERS MKT | money out | a person decides | Groceries 100.00% ✓ | Groceries 60.38% | Groceries 11.23% |
| VENMO *J RIVERA | money out | a person decides | None of these fit 76.00% | Gifts 15.76% | None of these fit 8.88% |
| TST* CORNER DELI | money out | a person decides | Eating Out 89.00% ✓ | Eating Out 35.25% | Eating Out 44.81% |
| AMZN MKTP US*2K4 | money out | a person decides | Shopping 97.00% ✓ | Shopping 25.49% | Shopping 22.61% |
| SP * CRAFTSUPPLY | money out | a person decides | Crafts 98.00% ✓ | Crafts 43.36% | Crafts 44.09% |
| POS 4417 CITY PARKING | money out | a person decides | Parking 100.00% ✓ | Parking 73.65% | Parking 65.18% |
| CHECKCARD 0921 CVS | money out | a person decides | Pharmacy 99.00% ✓ | Pharmacy 47.26% | Pharmacy 66.43% |
| APPLE.COM/BILL | money out | Household | Subscriptions 64.00% | Subscriptions 14.11% | Phone 13.33% |
| GOOGLE *YOUTUBE | money out | a person decides | Streaming 78.00% | Streaming 31.64% | Streaming 15.89% |
| DD *DOORDASH TACO | money out | a person decides | Eating Out 99.00% ✓ | Eating Out 29.65% | Eating Out 28.34% |
| DR MARTIN FAMILY PRACTICE REFUND | money in | a person decides | Doctor 87.00% ✓, flags: reimbursement | Doctor 21.89%, flags: reimbursement | None of these fit 9.14%, flags: reimbursement |
| GOOGLE *YOUTUBE PREMIUM | money out | Household | Streaming 85.00% ✓ | Subscriptions 32.02% | Streaming 26.63% |
| PROCREATE DREAMS | money out | Household | Hobbies 46.00% | Entertainment 11.31% | None of these fit 2.24% |
| CITY GYM MEMBERSHIP | money out | Household | Gym 100.00% ✓ | Gym 65.44% | Gym 73.91% |
| TARGET T-1432 | money in | Kids | Shopping 72.00% | Shopping 19.76% | Shopping 16.22% |
| LITTLE SPROUTS DAYCARE | money out | Childcare | Childcare 100.00% ✓ | Childcare 79.17% | Childcare 52.52% |
| HARBOR PROPERTY MGMT | money out | Rent | Rent 76.00% | Rent 41.68% | Rent 33.89% |
| NETFLIX.COM | money out | Household | Streaming 97.00% ✓ | Streaming 41.10% | Streaming 41.34% |

#### What each model sent back

##### Jev

First usage:

```json
{
  "input_tokens": 925,
  "output_tokens": 344
}
```

##### Clef

First usage:

```json
{
  "input_tokens": 1197,
  "output_tokens": 0
}
```

##### Clef-flash

First usage:

```json
{
  "input_tokens": 1197,
  "output_tokens": 0
}
```


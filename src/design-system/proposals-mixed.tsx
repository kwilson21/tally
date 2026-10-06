// P90 (spec §6.1, §7 and §8.2, decisions 60 and 74): a store that sells many kinds of things. The
// owner's answer on question 33 (rule offers after three saves): a store whose trips have gone in
// different categories, like Costco in Groceries 3 times and Household twice, gets no blanket
// "always" rule. Each trip is sorted on its own with the help of the filled-in details (P89), the
// family is encouraged to split a mixed trip so no category becomes a catch-all, and splits get
// Tally's suggestions as well as a person's own. The limit is honest: the bank sends only the total,
// so Tally can suggest which categories a split has, never the amounts. Each option is drawn on a
// phone from the real components, with the pieces that don't exist yet as prototypes in tokens, on
// today's date (Mon Oct 5). Nothing here is decided until the owner picks (decision 47).

import { Button } from "../views/button";
import { SplitLine } from "../views/split-form";
import { Fixed, Options, Title } from "./proposal-parts";
import { DetailsPanel, PanelHead } from "./proposals-autofill";
import { LedgerField } from "./proposals-forms";
import { MaybeRow } from "./proposals-phase4";
import {
	actions,
	CARD,
	Categories,
	COSTCO,
	Days,
	FIVE,
	HOUSEHOLD,
	NeedsLine,
	PanelForm,
	PanelSheet,
	PanelTop,
	RuleQuestion,
	TODAY,
	Toggles,
	TxHeader,
	tx,
} from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// Sample data. Costco's last 5 trips (Oct 3, Sep 28, Sep 19, Sep 12, Aug 30) went in Groceries 3
// times and Household twice, so it's mixed; today's trip is $214.36 and still needs a category.

const BANK_TEXT = "COSTCO WHSE #0412";
const TRIP = tx(30, TODAY, "Costco", 21436);

/** The categories the split's pickers list; the pictures show only the ones chosen. */
const CATEGORIES = [
	{ id: 1, name: "Groceries" },
	{ id: 2, name: "Eating Out" },
	{ id: 3, name: "Kids" },
	{ id: 4, name: "Gas" },
	{ id: 5, name: "Household" },
];

/** The list behind every panel: today's trip, needing a category, above the last one. */
const behind = (
	<>
		<TxHeader />
		<Days rows={[TRIP, COSTCO]} />
	</>
);

// ---------------------------------------------------------------------------------------------
// Option A: a nudge to split, with the parts suggested.

/**
 * The edit panel for a store that's mixed: no rule offer, and under the category chips a quiet
 * line whose terracotta "Split this one?" opens the split. The chips and toggles are today's.
 */
const nudge = (
	<PanelSheet behind={behind}>
		<PanelTop row={TRIP} raw={BANK_TEXT} account={CARD} />
		<PanelForm>
			<Categories p="p90-a" cats={FIVE}>
				<p class="flex flex-wrap items-center gap-x-1 text-sm text-muted">
					Costco trips go in Groceries and Household.
					<Button href="#p90-mixed-store" kind="text" class="-ml-2 text-sm">
						Split this one?
					</Button>
				</p>
			</Categories>
			<Toggles p="p90-a" />
			{actions}
		</PanelForm>
	</PanelSheet>
);

type Part = { category: number; amount: string };

/**
 * P17 A's split as it opens from the nudge (prototype, laid out as SplitForm is): the same live
 * line and Cancel and Save split, with each part's amount in P72 A's plain amount field, since
 * split parts take it rather than MoneyInput (decision 79, question 44). What's new is the label
 * saying where the parts came from, and each part's category drawn dashed, as every guess is
 * (decision 64), until a person types its amount or changes it (`kept`). The amounts start empty:
 * the bank sent only the total.
 */
function SuggestedSplit({ parts, kept }: { parts: Part[]; kept?: boolean }) {
	return (
		<div class="mt-4 flex flex-col gap-4 border-t border-rule pt-4">
			<div class="flex items-center justify-between gap-3">
				<div id={`p90-split-line${kept ? "-kept" : ""}`} aria-live="polite">
					<SplitLine
						parentCents={TRIP.amountCents}
						amounts={parts.map((p) => p.amount)}
					/>
				</div>
				<Button kind="text" type="button">
					Add a part
				</Button>
			</div>
			{!kept && (
				<p class="text-sm text-muted">
					Tally's guess: Household from this trip's details, Groceries from your
					other Costco trips
				</p>
			)}
			{parts.map((part, index) => (
				<div
					class={`flex flex-col gap-2 ${index ? "border-t border-rule pt-3" : ""}`}
				>
					<label
						for={`p90-part-category-${index}${kept ? "-kept" : ""}`}
						class="sr-only"
					>
						Part {index + 1} category
					</label>
					<select
						id={`p90-part-category-${index}${kept ? "-kept" : ""}`}
						name="part_category"
						class={`min-h-11 rounded-full border ${kept ? "border-rule" : "border-dashed border-ink"} bg-paper px-3`}
					>
						{CATEGORIES.map((cat) => (
							<option value={cat.id} selected={part.category === cat.id}>
								{cat.name}
							</option>
						))}
					</select>
					<LedgerField
						id={`p90-part-amount-${index}${kept ? "-kept" : ""}`}
						name="part_amount"
						label={`Part ${index + 1} amount`}
						value={part.amount}
						prefix="$"
						inputmode="decimal"
					/>
				</div>
			))}
			<div class="grid grid-cols-2 gap-3">
				<Button kind="secondary" type="button" class="w-full">
					Cancel
				</Button>
				<Button type="button" class="w-full">
					Save split
				</Button>
			</div>
		</div>
	);
}

/**
 * The split, as it opens, with no amounts: Household first, from this trip's details (paper towels,
 * detergent), then Groceries, Costco's most-used other category (decision 87). The split's
 * sheet is as tall as the phone allows, so nothing of the list shows above it, only the dimming.
 */
const splitSuggested = (
	<PanelSheet tall behind="">
		<PanelTop row={TRIP} raw={BANK_TEXT} account={CARD} />
		<SuggestedSplit
			parts={[
				{ category: 5, amount: "" },
				{ category: 1, amount: "" },
			]}
		/>
	</PanelSheet>
);

/**
 * The same split once the person has typed both amounts: nothing is dashed any more, the label
 * has gone, and the line says it adds up, as P17 A's split does (decision 60).
 */
const splitFilled = (
	<PanelSheet tall behind="">
		<PanelTop row={TRIP} raw={BANK_TEXT} account={CARD} />
		<SuggestedSplit
			kept
			parts={[
				{ category: 5, amount: "49.36" },
				{ category: 1, amount: "165.00" },
			]}
		/>
	</PanelSheet>
);

// ---------------------------------------------------------------------------------------------
// Option B: the category from the filled-in details only.

/** Each Costco trip's guess comes from its own "what it was" line (P89), so the two differ. */
const detailsList = (
	<>
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">3 transactions needing a category in October</p>
		<ul class="mt-2 divide-y divide-rule">
			<MaybeRow
				name="Costco"
				cents={21436}
				maybe="Household"
				line="paper towels, detergent"
			/>
			<MaybeRow
				name="Costco"
				cents={14260}
				maybe="Groceries"
				line="produce, chicken, milk"
			/>
			<MaybeRow name="Shell" cents={4410} maybe="Gas" line="fuel" />
		</ul>
	</>
);

/** The same guess in the edit panel: P89 A's rows and P32 A's dashed first chip, no nudge, no rule. */
const detailsPanel = (
	<DetailsPanel
		id="p90-b"
		head={<PanelHead raw={BANK_TEXT} cents={TRIP.amountCents} />}
		rows={[
			{ label: "Name", value: "Costco", from: "bank" },
			{
				label: "What it was",
				value: "Paper towels, detergent",
				from: "tally",
			},
		]}
		maybe={HOUSEHOLD}
	/>
);

// ---------------------------------------------------------------------------------------------
// Option C: ask once.

/** The third mixed save, in P62 B's place and shape, asking the opposite question. */
const askOnce = (
	<RuleQuestion
		saved="Saved as Household"
		question="Never offer a rule for Costco?"
		evidence="Costco has gone in different categories: Groceries 3 times, Household twice."
	/>
);

/** P90 on the proposals page, picked (decision 80), its rule settled (decision 87). */
export function MixedStoreProposals() {
	return (
		<Specimen
			id="p90-mixed-store"
			title="P90 · A store that sells many kinds of things"
			tier="visual"
			sentence="Some stores sell everything. A Costco trip goes in Groceries one week and Household the next, so “Always use Groceries for Costco?” would be wrong about as often as it's right. Pick what Tally does instead. Each is drawn on today's Costco trip (Oct 5, $214.36), at a store whose last 5 trips went in Groceries 3 times and Household twice."
		>
			<Fixed>
				P62 B's rule offer (decision 74): after the third save of one category
				for one merchant, the panel asks “Always use Groceries for Costco?”, Yes
				or Not now. A split's parts must add up exactly (§6.1), in P17 A's form
				(decision 60): a category and an amount for each part, and a live “$X
				left to assign”. AI suggests, code calculates, people decide (§2 rule
				6). The owner's answer to question 33: a store with evidence of
				different categories gets no blanket “always” rule; each trip is sorted
				on its own with help from Tally's filled-in details (P89's “what it was”
				line); the family is encouraged to split a mixed trip so no category
				becomes a catch-all; and splits get Tally's suggestions as well as a
				person's own. The honest limit: the bank sends only the total, so Tally
				can suggest which categories a split has, never the amounts. Amounts
				need a person or a receipt, and receipts are on the Later list (§12).
			</Fixed>
			<NeedsLine settled="decision 87">
				a store is mixed when a person has put its trips in two or more
				categories in the last 3 months, and a split trip counts through its
				parts, not the category it had before it was split (Q64 A). “Split this
				one?” shows on every trip to a mixed store, as drawn in Option A (Q66
				A). The two parts start with the categories the trip's details point to;
				when the details name only one, the store's most-used other category
				fills the second part (Q65 A), and when they name none, the store's two
				most-used categories fill both (Q67 A), all counted over the same 3
				months and skipping archived categories, which a split can't use. The
				amounts are always the person's, Tally never fills one in, and the split
				saves only when it adds up exactly (§6.1).
			</NeedsLine>
			<Options
				options={[
					{
						name: "Option A · A nudge to split, with the parts suggested",
						picked: true,
						note: "Picked, combined with B: Tally guesses one category from the trip's details, or suggests a split when they point to more than one. At a mixed store the panel never asks “Always use …?”, though a person can still tick Always for this merchant themselves. Under the category chips a quiet line says “Costco trips go in Groceries and Household. Split this one?”, with Split this one? in terracotta, on every Costco trip. Each trip's own category is still guessed from its “what it was” line (P89), as at any store.",
						tradeoff:
							"the panel has one more line, and the person types the amounts, because the bank's total is all Tally has.",
						recommended:
							"it's the honest fix for a mixed trip, and Tally does the part it can, which categories, without guessing the money.",
						screen: nudge,
					},
					{
						name: "Option A, next · The parts, suggested",
						note: "Split this one? opens P17 A's split with two parts already there, Household from this trip's details and Groceries, Costco's most-used other category (decision 87), drawn dashed because they're Tally's guess, and labelled with where they came from. Their amounts are empty and the line says “$214.36 left to assign”. A part turns solid once its amount is typed or its category changed.",
						tall: true,
						screen: splitSuggested,
					},
					{
						name: "Option A, next · Filled in, adding up",
						note: "The person types the amounts and the line counts down, then says “Adds up to $214.36” with a check. This is P17 A's form, with the plain amount field split parts now take (question 44). A split that doesn't add up exactly is still rejected (§6.1).",
						tall: true,
						screen: splitFilled,
					},
				]}
			/>
			<Options
				options={[
					{
						name: "Option B · Category by the filled-in details only",
						note: "No nudge to split and no rule offer. Each Costco trip gets its own guess from its “what it was” line (P89), written the way the list already writes a note: “Maybe Household · paper towels, detergent”. The person keeps it or picks another.",
						tradeoff:
							"a trip with two kinds of things in it still goes in one category, so one of them becomes the catch-all, and nothing leads a person to split.",
						screen: detailsList,
					},
					{
						name: "Option B, next · In the panel",
						note: "The same guess in the edit panel: the “What it was” row under the amount, and the category it led to as the first chip, dashed and marked Suggested.",
						screen: detailsPanel,
					},
					{
						name: "Option C · Ask once",
						note: "On the third save at a mixed store the panel stays open with one question, drawn like P62 B's: “Never offer a rule for Costco?”, with Yes and Not now. Yes is remembered like any never-ask (P88). Nothing else changes: no nudge to split, and each trip is guessed from its line.",
						tradeoff:
							"it asks about a rule nobody asked for, Not now brings it back on the next save, and a mixed trip still goes in one category.",
						screen: askOnce,
					},
				]}
			/>
		</Specimen>
	);
}

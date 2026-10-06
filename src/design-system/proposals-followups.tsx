// P73–P74: follow-ups from the owner's picks (decisions 74 and 75). P73 draws "suggested transactions
// for a new category", the owner's addition to P67 A; P74 (motion) is drawn in proposals-motion.tsx.
// Each option is drawn on a phone's first screen from the real components with demo-style data
// (today is Mon Oct 5), so the owner can pick by seeing (decision 47). Nothing here is decided until
// the owner picks.

import type { Child } from "hono/jsx";
import { shortDay } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { Icon } from "../views/icons";
import { SelectableTransactionRow } from "../views/selectable-transaction-row";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { WhyLink } from "../views/why-link";
import { Fixed, Options } from "./proposal-parts";
import { P74 } from "./proposals-motion";
import { NeedsLine } from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// P73: a new category with its likely transactions.

/** A transaction that still needs a category, as the list loads it (positive is money out). */
function needs(
	id: number,
	date: string,
	name: string,
	amountCents: number,
): ListRow {
	return {
		id,
		date,
		amountCents,
		rawName: name,
		displayName: name,
		note: null,
		excluded: false,
		income: false,
		creditReviewed: true,
		categoryId: null,
		categoryName: null,
		categoryIcon: null,
		categoryColor: null,
	};
}

/** The transaction the new category was made from: Banfield Pet Hospital, Sep 14, now in Pet Care. */
const SAVED: ListRow = {
	...needs(7300, "2026-09-14", "Banfield Pet Hospital", 18900),
	categoryId: 15,
	categoryName: "Pet Care",
	categoryIcon: "tag",
	categoryColor: "cat-plum",
};

/** What a same-merchant reason points at: the transaction the category was made from, by its date and amount. */
const SOURCE = `${shortDay(SAVED.date, SAVED.date)} (${formatCents(SAVED.amountCents)})`;

/** The reason behind a suggestion: code can show the first, only Tally's guess is AI (spec §2, rule 6). */
type Reason = "merchant" | "guess";
type Suggestion = { row: ListRow; ticked: boolean; reason: Reason };

/**
 * What Tally would offer after Pet Care is made from Banfield on Sep 14: transactions still needing
 * a category from this month and last (Sep 1 to Oct 5), same merchant first and ticked, then
 * Tally's guesses, unticked. Ids start at `base` so each picture's rows stay unique on the page.
 */
const suggestions = (base: number): Suggestion[] => [
	{
		row: needs(base + 1, "2026-10-02", "Banfield Pet Hospital", 7650),
		ticked: true,
		reason: "merchant",
	},
	{
		row: needs(base + 2, "2026-09-03", "Banfield Pet Hospital", 4800),
		ticked: true,
		reason: "merchant",
	},
	{
		row: needs(base + 3, "2026-09-29", "Chewy", 6412),
		ticked: false,
		reason: "guess",
	},
	{
		row: needs(base + 4, "2026-09-21", "Petsmart", 2399),
		ticked: false,
		reason: "guess",
	},
];

/**
 * The reason under a row, in plain words, lined up with the row's name (the round tick, the row's
 * icon and their gaps are 84px). A code reason is a fact about the transactions; an AI reason says
 * it's Tally's guess and has a Why?.
 */
function ReasonLine({ reason }: { reason: Reason }) {
	if (reason === "merchant") {
		return (
			<p class="pb-2 pl-21 text-sm text-muted">Same merchant as {SOURCE}</p>
		);
	}
	return (
		<div class="flex items-center gap-1 pb-2 pl-21">
			<p class="min-w-0 flex-1 text-sm text-muted">
				Tally's guess: none of your categories fit, and it reads like pet care.
			</p>
			<WhyLink section="categorization" topic="Tally's guess" />
		</div>
	);
}

/**
 * The likely transactions: each is the real SelectableTransactionRow with its reason under it. A row
 * is its own list because a list item can't hold the reason line without changing the component.
 */
function Suggestions({ items }: { items: Suggestion[] }) {
	return (
		<div class="divide-y divide-rule border-y border-rule">
			{items.map(({ row, ticked, reason }) => (
				<div>
					<ul>
						<SelectableTransactionRow row={row} checked={ticked} />
					</ul>
					<ReasonLine reason={reason} />
				</div>
			))}
		</div>
	);
}

/** The Transactions list as it sits behind a sheet; the sheet's backdrop dims it. */
function Behind() {
	return (
		<div class="px-5">
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Transactions
			</h1>
			<h2 class="mt-3 text-sm text-muted">Sep 14</h2>
			<ul class="divide-y divide-rule">
				<TransactionRow row={SAVED} />
				<TransactionRow row={needs(7399, "2026-09-12", "Costco", 14260)} />
			</ul>
		</div>
	);
}

/**
 * The edit panel's sheet, drawn in place: as tall as its content, or (`scrolled`) full height with
 * its content scrolled down to the end, so what's above it is cut off. The page shows dimmed above.
 */
function OverSheet({
	scrolled,
	children,
}: {
	scrolled?: boolean;
	children?: Child;
}) {
	return (
		<div class="relative -mx-5 h-[686px] overflow-hidden">
			<Behind />
			<div class="absolute inset-0 bg-ink/30" />
			{scrolled ? (
				<div class="absolute inset-x-0 bottom-0 top-16 overflow-hidden rounded-t-sheet bg-paper">
					<div class="absolute inset-x-0 bottom-0 flex flex-col gap-3 p-5">
						{children}
					</div>
				</div>
			) : (
				<div class="absolute inset-x-0 bottom-0 flex max-h-full flex-col gap-3 overflow-y-auto rounded-t-sheet bg-paper p-5">
					{children}
				</div>
			)}
		</div>
	);
}

/** A: after Save in the edit panel, the panel becomes the list of likely ones to add. */
const afterSave = (
	<OverSheet>
		<h2 class="font-serif text-4xl font-semibold tracking-tight">
			Pet Care is made.
		</h2>
		<p class="text-lg">These might belong too:</p>
		<Suggestions items={suggestions(7310)} />
		<div class="flex items-center gap-3">
			<Button type="button">Add 2 to Pet Care</Button>
			<Button kind="text" type="button">
				Not now
			</Button>
		</div>
	</OverSheet>
);

/**
 * B: one suggestion on the one review screen (P42 A): the dashed "Maybe …" is the question, with
 * its reason, Tally's guess and a Why? under it, then Yes, Something else and Skip.
 */
const reviewItem = (
	<>
		<a
			href="#p73-new-category-suggest"
			class="inline-flex min-h-11 items-center"
		>
			Settings
		</a>
		<h1 class="sr-only">Suggestions</h1>
		<p class="text-muted">Suggestions · 3 of 6</p>
		<h2 class="mt-2 font-serif text-3xl font-semibold tracking-tight">Chewy</h2>
		<p class="text-sm text-muted">CHEWY.COM 0412</p>
		<p class="mt-1 text-lg">−$64.12 · Sep 29</p>
		<div class="mt-5 border-t border-rule pt-5">
			<p>
				<span class="inline-flex items-center gap-2 rounded-control border border-dashed border-ink px-3 py-1 text-2xl">
					<CategoryIcon icon="tag" color="cat-plum" />
					Maybe Pet Care
				</span>
			</p>
			<p class="mt-2 text-lg">
				None of your categories fit, and it reads like pet care.
			</p>
			<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
				Tally's guess ·
				<WhyLink section="categorization" topic="Tally's guess" />
			</p>
		</div>
		<div class="mt-5 flex flex-col gap-3">
			<Button type="button" class="w-full">
				Yes, Pet Care
			</Button>
			<Button kind="secondary" type="button" class="w-full">
				Something else
			</Button>
			<div class="text-center">
				<Button kind="text" type="button">
					Skip
				</Button>
			</div>
		</div>
	</>
);

const SOME_CATS = [
	{ name: "Groceries", icon: "groceries", color: "cat-blue" },
	{ name: "Eating Out", icon: "eating-out", color: "cat-plum" },
	{ name: "Kids", icon: "kids", color: "cat-ochre" },
];

/** C: P67 A's panel, with its name field open and the likely ones listed under it, before Save. */
const beforeSave = (
	<OverSheet scrolled>
		<fieldset class="flex flex-col gap-2">
			<legend class="text-base text-ink">Category</legend>
			<div class="flex flex-wrap gap-2">
				{SOME_CATS.map((c) => (
					<Chip
						type="radio"
						name="p73-c-cat"
						value={c.name}
						icon={<CategoryIcon icon={c.icon} color={c.color} />}
					>
						{c.name}
					</Chip>
				))}
				<details open class="open:w-full">
					<summary class="inline-flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-full border border-rule px-4 text-base text-accent [&::-webkit-details-marker]:hidden">
						<Icon name="plus" class="size-4" />
						New category
					</summary>
					<div class="pt-3">
						<TextInput
							id="p73-c-name"
							label="New category name"
							value="Pet Care"
							hint="Added to your categories, with this transaction and the ticked ones below."
							autocomplete="off"
							surface="paper"
						/>
					</div>
				</details>
			</div>
		</fieldset>
		<div class="flex flex-col gap-2">
			<p class="text-lg">These might belong too:</p>
			<Suggestions items={suggestions(7320).slice(0, 3)} />
		</div>
		<div class="grid grid-cols-2 gap-3">
			<Button kind="secondary" type="button" class="w-full">
				Cancel
			</Button>
			<Button type="button" class="w-full">
				Save
			</Button>
		</div>
	</OverSheet>
);

/** P73 on the proposals page, open for the owner's pick. */
function P73() {
	return (
		<Specimen
			id="p73-new-category-suggest"
			title="P73 · A new category with its likely transactions"
			tier="visual"
			sentence="You picked P67 A, a “New category” chip that makes the category and files this transaction at once, and asked for suggested transactions too, with the reason for each. Pick when Tally offers them. Each is drawn with Pet Care, made from Banfield Pet Hospital."
		>
			<Fixed>
				a “New category” chip in the edit panel and Organize opens a name field
				in place and saves both at once (P67 A, decision 74); a new category
				gets the tag icon and the next color (§12), and names are unique
				ignoring case (§7); AI suggests and people decide, so a suggestion is
				never applied without a tap and a person's own pick is never overwritten
				(§2 rule 6, §7); screens say “Tally's guess”, never the AI's name
				(decision 64).
			</Fixed>
			<NeedsLine settled="decisions 76 and 79">
				Each row gives one of two reasons: “Same merchant”, which names the
				transaction it matches and starts ticked, or “Tally's guess”, which
				starts unticked with a Why? and only when the new name is one Tally had
				suggested for them. The offer is up to 6 other transactions from this
				month and last, same merchant first, then guesses, newest first within
				each, in the edit panel only for now. Nothing moves until a person taps
				Add.
			</NeedsLine>
			<Options
				options={[
					{
						name: "Option A · Right after creating it",
						picked: true,
						note: "After Save, the panel becomes “Pet Care is made. These might belong too:”, a list of the likely ones, each with its reason. Same-merchant ones are ticked, guesses are not. Add 2 to Pet Care is the primary; Not now leaves them as they were.",
						tradeoff:
							"one more step after Save, but only when there's something to suggest.",
						recommended:
							"you're thinking about that category right then, the panel stays as you picked it in P67, and the guesses are worked out from the name you finally saved.",
						screen: afterSave,
					},
					{
						name: "Option B · On the review screen",
						note: "The suggestions wait as “Maybe Pet Care” on the one review screen (P42 A), one at a time, each with its reason; in the list a row shows P32's dashed Maybe. Same-merchant ones are asked the same way, with “Same merchant”. Drawn with Chewy.",
						tradeoff:
							"it's the one Maybe pattern, but it waits for a trip to the review screen, and ones that code is sure of cost a yes or no each.",
						screen: reviewItem,
					},
					{
						name: "Option C · Inline, before saving",
						note: "While you name it, the same list sits under the name field, so one Save makes the category and files every ticked one. Drawn scrolled down to the name field and the list.",
						tradeoff:
							"the panel gets about as long again, so it scrolls on a phone (drawn scrolled to the end), and the guesses redraw when the name changes (a request, announced by its count).",
						screen: beforeSave,
					},
				]}
			/>
		</Specimen>
	);
}

/** P73 and P74 on the proposals page. */
export function FollowupProposals() {
	return (
		<>
			<P73 />
			<P74 />
		</>
	);
}

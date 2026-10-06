// P75: squircle corners, CSS only. The owner saw Monoco (somonoco.com), a script that draws
// "squircle" smooth corners, and asked to see them drawn for Tally without a script. The CSS
// property `corner-shape: squircle` does it, working with border-radius: the radius stays the same
// token and only the curve changes. It ships in Chrome and Edge 139+ and Opera, not in Safari or
// Firefox, which keep ordinary rounded corners, so it is a progressive enhancement: the family's
// iPhones would see today's corners until Safari adds it. The owner picked A (decision 76) and it
// now ships: one rule in app.css sets the property on every rounded-control and rounded-sheet.
//
// How the pictures are drawn: each is the same screen, so the corners are the only difference. A
// wrapper inside the phone frame sets `corner-shape` for the parts an option names, found by their
// token class (`.rounded-control`, `.rounded-t-sheet`) with a Tailwind arbitrary variant and
// property. That keeps the real components untouched and uses no inline style (the CSP forbids it).
// The property isn't inherited, so it has to be set on those parts, not on the wrapper.
//
// Because the app's rule now draws every part as a squircle in Chrome and Edge, Today has to say so
// the other way: its wrapper forces every part inside it round (`[&_*]:[corner-shape:round]`). That
// beats the rule because the rule sits in the components layer, below Tailwind's utilities. B forces
// the same and then turns the buttons and the sheet back on, so its field keeps its round corners as
// its note says. A needs nothing (the rule already draws it) but sets the property anyway, so the
// picture doesn't depend on the rule. The phone frame itself sits outside the wrapper, so it follows
// the app's rule in all three. The design-token test lists this file as the one place that may set
// corner-shape besides that rule.
//
// Chips and the round ticks are `rounded-full` in the code, even though DESIGN.md lists chips under
// rounded-control, so the rule as proposed ("every rounded-control and rounded-sheet") leaves them
// as pills. The pictures show exactly what that rule does.
//
// Option C (a larger squircle, so the softness reads on a phone) is not drawn. Drawn at the same
// radius, a squircle looks a little squarer than a round corner (see the close-up), so a larger
// radius is the obvious follow-up question if A reads too square. But radii must stay the two
// tokens: rounded-control is 0.75rem and rounded-sheet is 1.25rem. The only larger one is
// rounded-sheet, which DESIGN.md keeps for the sheet's top corners, and 1.25rem on a 44px control
// (half its height is 1.375rem) is close to a pill. That is a different proposal, rounder
// controls, and it would need a new token or a new use of one. It is not a choice of corner shape.

import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { TextInput } from "../views/text-input";
import { TransactionRow } from "../views/transaction-row";
import { Fixed, Options, Sheet, Title } from "./proposal-parts";
import { NeedsLine } from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

type Look = "today" | "a" | "b";

/**
 * What each look sets, written out whole because Tailwind finds a class by its full text. Today
 * forces everything inside it round, which the app's squircle rule would otherwise undo in Chrome
 * and Edge. A turns squircles on for everything drawn with a token radius: buttons, fields and the
 * sheet's top corners. B forces everything round, then turns squircles on for the buttons and the
 * sheet only.
 */
const ROUND = "[&_*]:[corner-shape:round]";
const LOOKS: Record<Look, string> = {
	today: ROUND,
	a: "[&_.rounded-control]:[corner-shape:squircle] [&_.rounded-t-sheet]:[corner-shape:squircle]",
	b: `${ROUND} [&_button.rounded-control]:[corner-shape:squircle] [&_a.rounded-control]:[corner-shape:squircle] [&_.rounded-t-sheet]:[corner-shape:squircle]`,
};

// ---------------------------------------------------------------------------------------------
// Sample data, in the demo's style: October, five days in.

const GROCERIES = { name: "Groceries", icon: "groceries", color: "cat-blue" };
const GAS = { name: "Gas", icon: "gas", color: "cat-slate" };

/** A list row as the app loads it; amounts are Plaid's way round (positive is money out). */
function tx(id: number, date: string, name: string, cents: number): ListRow {
	return {
		id,
		date,
		amountCents: cents,
		rawName: name,
		displayName: name,
		note: null,
		excluded: false,
		income: false,
		creditReviewed: true,
		categoryId: 1,
		categoryName: GROCERIES.name,
		categoryIcon: GROCERIES.icon,
		categoryColor: GROCERIES.color,
	};
}

const COSTCO = tx(1, "2026-10-03", "Costco", 14260);
const TRADER_JOES = tx(2, "2026-10-04", "Trader Joe's", 8217);

/** The Transactions screen behind the sheet, dimmed: its title, count and the first two rows. */
const behind = (
	<>
		<Title>Transactions</Title>
		<p class="mt-2 text-muted">18 transactions in October</p>
		<ul class="mt-2 divide-y divide-rule">
			<TransactionRow row={TRADER_JOES} />
			<TransactionRow row={COSTCO} />
		</ul>
	</>
);

// ---------------------------------------------------------------------------------------------
// The picture: the edit panel over Transactions, the busiest-cornered screen Tally has.

/**
 * A category chip with its icon; the first is chosen. Names are unique per picture because radios
 * that share a name are one group across the whole page, and each picture starts with one chosen.
 */
function CategoryChip({
	p,
	cat,
	checked,
}: {
	p: string;
	cat: typeof GROCERIES;
	checked?: boolean;
}) {
	return (
		<Chip
			type="radio"
			name={`${p}-cat`}
			value={cat.name}
			checked={checked}
			icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
		>
			{cat.name}
		</Chip>
	);
}

/**
 * The edit panel (owner's pick C, #27) as it opens on Costco: the name and amount, the category
 * chips, the two toggle chips, the merchant name field and Cancel and Save. The real panel shows
 * every category and keeps the field behind "Rename or add a note"; here two categories and the
 * open field are drawn, since a field is one of the parts whose corners change. The sheet's strip
 * is short (a picture can't scroll), so the date line is left out and Save stays in view.
 */
function EditPanel({ p, look }: { p: string; look: Look }) {
	return (
		<div class={LOOKS[look]}>
			<Sheet behind={behind}>
				<div class="flex items-baseline justify-between gap-3">
					<h2 class="font-serif text-4xl font-semibold tracking-tight">
						Costco
					</h2>
					<p class="font-serif text-4xl font-semibold">
						{formatCents(COSTCO.amountCents, { signed: true })}
					</p>
				</div>
				<fieldset class="flex flex-col gap-2">
					<legend class="text-base text-ink">Category</legend>
					<div class="flex flex-wrap gap-2">
						<CategoryChip p={p} cat={GROCERIES} checked />
						<CategoryChip p={p} cat={GAS} />
					</div>
				</fieldset>
				<div class="flex flex-wrap gap-2">
					<Chip type="checkbox" name={`${p}-always`} value="1" checked>
						Always for this merchant
					</Chip>
					<Chip type="checkbox" name={`${p}-excluded`} value="1">
						Exclude from budget
					</Chip>
				</div>
				<TextInput
					id={`${p}-merchant`}
					label="Merchant name"
					name={`${p}-merchant`}
					value="Costco"
					autocomplete="off"
				/>
				<div class="grid grid-cols-2 gap-3">
					<Button kind="secondary" type="button" class="w-full">
						Cancel
					</Button>
					<Button type="button" class="w-full">
						Save
					</Button>
				</div>
			</Sheet>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// The close-up: one of each kind of part at twice its size, so a screenshot shows the curve.

/**
 * The parts a person touches and sees, drawn large with CSS `zoom` (a transform wouldn't change the
 * layout size): Cancel and Save, a category chip chosen and one not, the field, a toast-like box (the
 * toast is `rounded-control`; its one shadow is left off, as P74 does) and the sheet's top edge over
 * its dimmed backdrop. It's an inert, labelled picture like the phones.
 *
 * It is as wide as a phone picture (392px), because the proposals column is 824px wide at every
 * screen size: two of these sit side by side there, where two wider ones would stack and the
 * comparison would need scrolling. At 2× that leaves about 195px of layout width, and Cancel plus Save
 * need about 180 of it, so the padding and gap are tight (p-1.5, gap-1.5) to keep them on one row; the
 * chips wrap to a row each, which is fine.
 */
function CloseUp({ p, look, label }: { p: string; look: Look; label: string }) {
	return (
		<div class="flex w-[392px] max-w-full flex-col gap-2">
			<p class="font-semibold">{label}</p>
			<div
				role="img"
				aria-label={`${label}, close up`}
				class="overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert class={`${LOOKS[look]} [zoom:2]`}>
					<div class="flex flex-col gap-2 p-1.5">
						<div class="flex flex-wrap gap-1.5">
							<Button kind="secondary" type="button">
								Cancel
							</Button>
							<Button type="button">Save</Button>
						</div>
						<div class="flex flex-wrap gap-2">
							<CategoryChip p={p} cat={GROCERIES} checked />
							<CategoryChip p={p} cat={GAS} />
						</div>
						<TextInput
							id={`${p}-merchant`}
							label="Merchant name"
							name={`${p}-merchant`}
							value="Costco"
							autocomplete="off"
						/>
						<p
							role="status"
							class="rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink"
						>
							Saved Costco
						</p>
					</div>
					<div class="bg-ink/30 pt-4">
						<div class="h-8 rounded-t-sheet bg-paper" />
					</div>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------

export function P75() {
	return (
		<Specimen
			id="p75-corners"
			title="P75 · Squircle corners"
			sentence="The same two radii with a smoother squircle curve, from one CSS property and no script. Pick whether the app uses it, and where."
			tier="visual"
		>
			<Fixed>
				radii are the two tokens (rounded-control, rounded-sheet) and no shadows
				(DESIGN.md); the CSP allows no inline styles.
			</Fixed>
			<NeedsLine settled="decisions 76, 79 and 85">
				It's Chrome and Edge only today: Safari (iPhones) and Firefox keep
				today's round corners until they support it, so nothing breaks. One rule
				in app.css sets corner-shape: squircle on the two radius tokens, so
				buttons, fields and the sheet are squircles and chips stay pills. The
				money box and its cent arrows use the same token, so they are squircles
				too (decision 85).
			</NeedsLine>
			<p class="max-w-prose text-sm text-muted">
				To see the difference, open this page in Chrome or Edge. In Safari or
				Firefox every picture below shows today's corners, which is what those
				browsers would show in the app whatever is picked. The app now draws
				Option A, so the Today pictures are forced round to keep the comparison.
			</p>
			<Options
				options={[
					{
						name: "Today · Round corners",
						note: "The current look: ordinary round corners, 0.75rem on buttons and fields and 1.25rem on the sheet's top edge.",
						screen: <EditPanel p="p75-today" look="today" />,
					},
					{
						name: "Option A · Squircles everywhere",
						picked: true,
						note: "corner-shape: squircle on every rounded-control and rounded-sheet: the sheet's top corners, the buttons and the field. At the same radius the curve blends into the edge, so the corner looks a little squarer. Chips are pills, so they stay as they are.",
						tradeoff:
							"Safari (iPhones) and Firefox keep today's corners until they add it.",
						recommended:
							"a smoother, more “made” curve with no script, and older browsers keep today's.",
						screen: <EditPanel p="p75-a" look="a" />,
					},
					{
						name: "Option B · Squircles on the sheet and buttons only",
						note: "The sheet's top corners and the buttons are squircles; the field keeps its round corners.",
						tradeoff:
							"two corner styles on one screen: a button and the field above it no longer match.",
						screen: <EditPanel p="p75-b" look="b" />,
					},
				]}
			/>
			<div class="flex flex-col gap-3">
				<p class="font-semibold">Today and A, side by side, close up</p>
				<p class="max-w-prose text-sm">
					The parts at twice their size so the curve shows: Cancel and Save, a
					category chip chosen and one not, a field, a toast and the sheet's top
					edge over its dimmed backdrop. Look at Save and the field: the
					squircle blends into the straight edge and sits squarer in the corner
					(on a phone the change is much smaller). The chips are pills, so they
					match in both.
				</p>
				<div class="flex flex-wrap gap-8">
					<CloseUp
						p="p75-cu-today"
						look="today"
						label="Today · Round corners"
					/>
					<CloseUp
						p="p75-cu-a"
						look="a"
						label="Option A · Squircles everywhere"
					/>
				</div>
			</div>
		</Specimen>
	);
}

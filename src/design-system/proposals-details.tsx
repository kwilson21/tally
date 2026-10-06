// P76–P87: the open questions in docs/reviews/open-questions-2026-10-05.md that change how a screen
// looks, each drawn so the owner decides by seeing (decision 47). Every picture is the screen the
// earlier picked drawing made, with only the detail in question changing: the real components in
// src/views/, and the picked drawings' own prototypes (imported from the proposals-*.tsx files that
// drew them) where a component doesn't exist yet. Today is Mon Oct 5, as in every proposal.
// The owner's picks are marked Picked (decision 80).

import type { Child } from "hono/jsx";
import { dayLabel } from "../dates";
import { formatCents } from "../money";
import { BillRow, BillStatusHeading } from "../views/bill-row";
import { Wordmark } from "../views/brand";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { Icon } from "../views/icons";
import { SIDEBAR_ITEMS } from "../views/nav";
import { TransactionRow } from "../views/transaction-row";
import { WhyLink } from "../views/why-link";
import { Fixed, Options, Title } from "./proposal-parts";
import {
	AiGroup,
	Answers,
	askIncome,
	ElseNames,
	FEATURES,
	type Feature,
	OFF_MEANS,
	Question,
	ReviewHead,
	SwitchRow,
	Why,
} from "./proposals-ai";
import {
	type Bill,
	billsBehind,
	CategoryChips,
	Chevron,
	categoryValue,
	DueRow,
	Footer,
	LedgerField,
	MatchRow,
	RENT,
	Row,
	summaryRow,
	TallSheet,
	transactionsBehind,
} from "./proposals-forms";
import { CATS, NameChoices, SuggestedRow } from "./proposals-phase4";
import {
	bill,
	CAR,
	dollars,
	ELECTRIC,
	INTERNET,
	LineRow,
	PaymentRow,
	RENT_CAT,
	toPay,
	UTILITIES,
} from "./proposals-phase5-bills";
import {
	AMAZON,
	actions,
	BLUE_BOTTLE,
	type Cat,
	Categories,
	COSTCO,
	Days,
	EATING_OUT,
	FIVE,
	GAS,
	GROCERIES,
	HOUSEHOLD,
	KIDS,
	LUPITAS,
	PanelForm,
	PanelSheet,
	PanelTop,
	Search,
	SelectBar,
	SelectScreen,
	SHELL,
	TITLE,
	TODAY,
	Toggles,
	TRADER_JOES,
	TxHeader,
	tx,
} from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

/** A day's heading and its rows, as the Transactions list draws them. */
function Day({ date, children }: { date: string; children?: Child }) {
	return (
		<>
			<h2 class="mt-3 text-sm text-muted">{dayLabel(date, TODAY)}</h2>
			<ul class="divide-y divide-rule">{children}</ul>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// P76: where "Maybe income" shows (question 5; P42 A, P32 A).

/** An unreviewed bank credit that looks like pay: held out of spending until someone says (decision 70). */
const PAY = tx(31, "2026-10-03", "Acme Payroll", -245000, undefined, {
	creditReviewed: false,
});

/** P32 A's row for a guess below the threshold: the dashed tag where "Review credit" is today. */
function MaybeIncomeRow() {
	return (
		<li class="flex h-16 items-center gap-4">
			<span class="shrink-0 text-muted">
				<Icon name="circle-dashed" class="size-7" />
			</span>
			<span class="min-w-0 flex-1">
				<span class="block truncate text-lg leading-6">{PAY.displayName}</span>
				<span class="flex min-w-0 items-center gap-2 leading-6">
					<span class="shrink-0 rounded-control border border-dashed border-ink px-2 text-sm text-ink">
						Maybe income
					</span>
				</span>
			</span>
			<span class="shrink-0 text-lg">
				{formatCents(PAY.amountCents, { signed: true })}
			</span>
		</li>
	);
}

/** Transactions with the paycheck row drawn by `pay`; the rest of the list is the real rows. */
function PayList({ pay }: { pay: Child }) {
	return (
		<>
			<TxHeader />
			<p aria-live="polite" class="mt-4 text-sm text-muted">
				4 transactions in October
			</p>
			<Day date="2026-10-05">
				<TransactionRow row={BLUE_BOTTLE} />
			</Day>
			<Day date="2026-10-04">
				<TransactionRow row={TRADER_JOES} />
			</Day>
			<Day date="2026-10-03">
				{pay}
				<TransactionRow row={COSTCO} />
			</Day>
		</>
	);
}

/** A: the edit panel of the credit; "Count as income" is dashed, with Tally's guess under it. */
const maybeIncomePanel = (
	<TallSheet behind={<TxHeader />} gap="gap-3">
		<PanelTop
			row={PAY}
			raw="ACME PAYROLL PPD"
			account="Chase Checking ••4410"
		/>
		<PanelForm>
			<Categories p="p76-a" cats={[GROCERIES, HOUSEHOLD]} />
			<Toggles p="p76-a" />
			<div class="flex flex-col gap-2 border-t border-rule pt-3">
				<p class="text-base text-ink">Income</p>
				<div class="flex flex-wrap gap-2">
					<span class="rounded-full border border-dashed border-ink">
						<Chip
							type="checkbox"
							name="p76-a-income"
							value="1"
							describedBy="p76-a-guess"
						>
							Count as income
						</Chip>
					</span>
				</div>
				<p
					id="p76-a-guess"
					class="flex flex-wrap items-center gap-x-2 text-sm text-muted"
				>
					Tally's guess · 71% sure
					<WhyLink section="categorization" topic="Tally's guess" />
				</p>
			</div>
			<div class="flex flex-col gap-2 border-t border-rule pt-3">
				<p class="text-sm text-muted">
					This bank credit is held out of spending until you identify it.
				</p>
				<Chip type="checkbox" name="p76-a-reviewed" value="1">
					Reviewed as a refund or other non-income credit
				</Chip>
			</div>
		</PanelForm>
	</TallSheet>
);

// ---------------------------------------------------------------------------------------------
// P77: a switched-off feature in "What AI did" (question 20; P43 A under P41 B's switches).

/** The group as P41 B draws it, Income switched off, with P43 A's "In October" tally under it. */
function AiDidScreen({ income }: { income: Child }) {
	const states = [true, true, false, true];
	return (
		<div class="overflow-hidden">
			{/* Scrolled past the group's heading and its line (88px), so the switches and the whole
			    tally fit on the phone's first screen. */}
			<section class="-mt-[88px]">
				<AiGroup intro={OFF_MEANS}>
					<ul class="mt-3 divide-y divide-rule border-y border-rule">
						{FEATURES.map((f, i) => (
							<SwitchRow f={f} on={states[i] ?? true} />
						))}
					</ul>
					<div class="mt-4">
						<Button type="button">Save</Button>
					</div>
				</AiGroup>
				<h3 class="mt-5 text-sm text-muted">In October</h3>
				<ul class="mt-1">
					<li>Sorted 84 transactions · you changed 5</li>
					<li>Cleaned 12 merchant names</li>
					{income}
				</ul>
				<Why topic="what Tally did" href="#p43-did" />
			</section>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// P78: "Part paid" before it's overdue (question 28; P58 A). Rent is $1,200, due Wed Oct 7, and
// $600 of it has been paid.

const RENT_SOON = bill(6, "Rent", 120000, "due", "2026-10-07", RENT_CAT);
const PAID_SO_FAR = 60000;
const LEFT_TO_PAY = RENT_SOON.amountCents - PAID_SO_FAR + ELECTRIC.amountCents;

type Group = { heading: Child; rows: Child };

/** Bills as the page draws it (title, sentence, Add a bill, then each group), with groups given. */
function BillsPage({ groups }: { groups: Group[] }) {
	return (
		<>
			<Title>Bills</Title>
			<p class="mt-2 font-serif text-lg italic">{toPay(2, LEFT_TO_PAY)}</p>
			<div class="mt-3">
				<Button kind="secondary" type="button">
					Add a bill
				</Button>
			</div>
			{groups.map((g) => (
				<section class="mt-4">
					{g.heading}
					<ul class="divide-y divide-rule">{g.rows}</ul>
				</section>
			))}
		</>
	);
}

const upcoming: Group = {
	heading: <BillStatusHeading status="upcoming" />,
	rows: (
		<>
			<BillRow bill={INTERNET} today={TODAY} />
			<BillRow bill={CAR} today={TODAY} />
		</>
	),
};

/** A: Rent stays in Due in the next 7 days, its row saying how much is paid. */
const partPaidWhereItIs = (
	<BillsPage
		groups={[
			{
				heading: <BillStatusHeading status="due" />,
				rows: (
					<>
						<LineRow
							bill={RENT_SOON}
							line={`Part paid: ${dollars(PAID_SO_FAR)} of ${dollars(RENT_SOON.amountCents)}`}
						/>
						<BillRow bill={ELECTRIC} today={TODAY} />
					</>
				),
			},
			upcoming,
		]}
	/>
);

/** B: a group of its own, headed like Overdue (the alert icon and the words), above the rest. */
const partPaidOwnGroup = (
	<BillsPage
		groups={[
			{
				heading: (
					<h2 class="flex items-center gap-2 text-sm text-muted">
						<span class="text-over">
							<Icon name="alert" class="size-4" />
						</span>
						Part paid
					</h2>
				),
				rows: (
					<LineRow
						bill={RENT_SOON}
						line={`${dollars(PAID_SO_FAR)} of ${dollars(RENT_SOON.amountCents)} paid`}
					/>
				),
			},
			{
				heading: <BillStatusHeading status="due" />,
				rows: <BillRow bill={ELECTRIC} today={TODAY} />,
			},
			upcoming,
		]}
	/>
);

// ---------------------------------------------------------------------------------------------
// P79: the category from a bill, in the edit panel (question 29; P59 A). Harbor Property's $1,200
// payment had no category and paid the Rent bill, so it took Rent.

const HARBOR = tx(41, "2026-10-01", "Harbor Property", 120000, RENT_CAT);

/** The one place a person can tap through to the bill: the link's own look, as Why? has it. */
const LINK =
	"inline-flex min-h-11 items-center text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** C: under the day line, which bill the payment paid; "Rent bill" goes to that bill's page. */
const paidTheBill = (
	<span class="-my-2.5 flex items-center">
		Paid the&nbsp;
		<a href="/bills/6" class={LINK}>
			Rent bill
		</a>
	</span>
);

/** D: the chosen chip's mark, a small bills icon and where Rent came from, as P32's "Suggested" marks a guess. */
const fromTheBill = (
	<>
		<span aria-hidden="true">·</span>
		<Icon name="bills" class="size-4" />
		from the bill
	</>
);

type RentPanelProps = {
	p: string;
	/** A: a muted line under the chips. */
	line?: string;
	/** C: the day line's link to the bill. */
	lineEnd?: Child;
	/** E: beside the "Category" label. */
	labelEnd?: Child;
	/** D: on the chosen chip. */
	selectedEnd?: Child;
};

/** The rent payment's panel; the row above it, drawn as P59 A has it, already says where Rent came from. */
function RentPanel({
	p,
	line,
	lineEnd,
	labelEnd,
	selectedEnd,
}: RentPanelProps) {
	return (
		<PanelSheet
			behind={
				<Day date="2026-10-01">
					<PaymentRow
						name="Harbor Property"
						cents={120000}
						cat={RENT_CAT}
						bill="Rent"
					/>
				</Day>
			}
		>
			<PanelTop
				row={HARBOR}
				raw="HARBOR PROPERTY MGMT"
				account="Chase Checking ••4410"
				lineEnd={lineEnd}
			/>
			<PanelForm>
				<Categories
					p={p}
					cats={[RENT_CAT, HOUSEHOLD, UTILITIES]}
					selected="Rent"
					labelEnd={labelEnd}
					selectedEnd={selectedEnd}
				>
					{line && <p class="text-sm text-muted">{line}</p>}
				</Categories>
				<Toggles p={p} />
				{actions}
			</PanelForm>
		</PanelSheet>
	);
}

// ---------------------------------------------------------------------------------------------
// P80: finding one in "Always for these merchants" (question 40; P69 A). Organize makes a rule for
// every merchant it sorts, so the list grows: 34 here.

type Rule = [merchant: string, cat: Cat, transactions: number];

const ALDI: Rule = ["Aldi", GROCERIES, 9];
const AMAZON_RULE: Rule = ["Amazon", HOUSEHOLD, 41];
const BLUE_BOTTLE_RULE: Rule = ["Blue Bottle Coffee", EATING_OUT, 14];
const CHEVRON: Rule = ["Chevron", GAS, 12];
const CHIPOTLE: Rule = ["Chipotle", EATING_OUT, 8];
const COSTCO_RULE: Rule = ["Costco", GROCERIES, 23];
const COSTCO_GAS: Rule = ["Costco Gas", GAS, 17];
const DISCOUNT_TIRE: Rule = ["Discount Tire", GAS, 2];

/** A–Z, as the list shows them; the pictures draw the first few. */
const RULES_A_TO_Z: Rule[] = [
	ALDI,
	AMAZON_RULE,
	BLUE_BOTTLE_RULE,
	CHEVRON,
	CHIPOTLE,
	COSTCO_RULE,
	COSTCO_GAS,
	DISCOUNT_TIRE,
];

/** P69 A's row: the merchant, its category and how many it has sorted, with Remove. */
function RuleRow({ rule, grouped }: { rule: Rule; grouped?: boolean }) {
	const [merchant, cat, n] = rule;
	return (
		<li class="flex min-h-16 items-center gap-4 py-2">
			{!grouped && <CategoryIcon icon={cat.icon} color={cat.color} />}
			<span class="min-w-0 flex-1">
				<span class="block text-lg leading-6">
					{merchant}
					{!grouped && (
						<>
							{" "}
							<span class="whitespace-nowrap">
								<span aria-hidden="true">→ </span>
								<span class="sr-only">is always </span>
								{cat.name}
							</span>
						</>
					)}
				</span>
				<span class="block leading-6 text-muted">
					{grouped
						? `${n} transactions`
						: `Always ${cat.name} · ${n} transactions`}
				</span>
			</span>
			<Button kind="text" type="button">
				Remove<span class="sr-only"> {merchant}</span>
			</Button>
		</li>
	);
}

/** The section's top: its name and the one line P69 A gave it. */
function RulesTop({ id, children }: { id: string; children?: Child }) {
	return (
		<>
			<h1 class={TITLE}>Settings</h1>
			<section class="mt-8" aria-labelledby={id}>
				<h2 id={id} class="font-serif text-3xl font-semibold">
					Always for these merchants
				</h2>
				<p class="mt-1 text-muted">Tally sorts these merchants for you.</p>
				{children}
			</section>
		</>
	);
}

/** A: A–Z with a search box (there are more than 20), and the count above the list. */
function rulesAToZ(id: string, q: string, count: string, rules: Rule[]) {
	return (
		<RulesTop id={`${id}-heading`}>
			<div class="mt-3">
				<Search id={id} q={q} what="merchants" />
			</div>
			<p aria-live="polite" class="mt-3 text-sm text-muted">
				{count}
			</p>
			<ul class="mt-1 divide-y divide-rule border-y border-rule">
				{rules.map((r) => (
					<RuleRow rule={r} />
				))}
			</ul>
		</RulesTop>
	);
}

/** One group of B: the category's name and how many merchants it holds, then its rules. */
function RuleGroup({
	cat,
	merchants,
	rules,
}: {
	cat: Cat;
	merchants: number;
	rules: Rule[];
}) {
	return (
		<>
			<h3 class="mt-4 flex items-center gap-2 text-sm text-muted">
				<CategoryIcon icon={cat.icon} color={cat.color} />
				{cat.name} · {merchants} merchants
			</h3>
			<ul class="divide-y divide-rule border-y border-rule">
				{rules.map((r) => (
					<RuleRow rule={r} grouped />
				))}
			</ul>
		</>
	);
}

/** B: the same rules under their category's name, the way a long list could be broken up. */
const rulesGrouped = (
	<RulesTop id="p80-b-heading">
		<p aria-live="polite" class="mt-3 text-sm text-muted">
			34 merchants in 5 categories
		</p>
		<RuleGroup cat={GROCERIES} merchants={9} rules={[ALDI, COSTCO_RULE]} />
		<RuleGroup
			cat={EATING_OUT}
			merchants={6}
			rules={[BLUE_BOTTLE_RULE, CHIPOTLE]}
		/>
		<RuleGroup cat={GAS} merchants={7} rules={[CHEVRON, COSTCO_GAS]} />
	</RulesTop>
);

// ---------------------------------------------------------------------------------------------
// P81: Select all's words (question 41; P70 A). Select mode in October, 25 rows to a page.

/** The six newest October rows, with ids from `base` so each picture's rows stay unique. */
const october = (base: number) => [
	tx(base + 1, "2026-10-05", "Blue Bottle Coffee", 650, EATING_OUT),
	tx(base + 2, "2026-10-04", "Trader Joe's", 8217, GROCERIES),
	tx(base + 3, "2026-10-04", "Lupita's Taqueria", 4290, EATING_OUT),
	tx(base + 4, "2026-10-03", "Costco", 14260, GROCERIES),
	tx(base + 5, "2026-10-02", "Amazon", 4217, HOUSEHOLD),
	tx(base + 6, "2026-10-02", "Shell", 4410, GAS),
];

const IN_OCTOBER = "Showing 1–25 of 112 transactions in October";

/** A, first: three ticked, and the link says exactly what it will tick. */
const selectLink = (
	<SelectScreen
		count={IN_OCTOBER}
		rows={october(8100)}
		checked={[8101, 8103, 8104]}
		bar={<SelectBar selected={3} link="Select all 112 in October" />}
	/>
);

/** A, next: all 112 were ticked and one was unticked, so the rest stay ticked. */
const selectOneOff = (
	<SelectScreen
		count={IN_OCTOBER}
		rows={october(8200)}
		checked={[8201, 8202, 8203, 8205, 8206]}
		bar={<SelectBar selected={111} link="Select all 112 in October" />}
	/>
);

/** A, All months: the same words, naming the months. */
const selectAllMonths = (
	<SelectScreen
		count="Showing 1–25 of 340 transactions in all months"
		rows={[
			tx(8301, "2026-10-05", "Blue Bottle Coffee", 650, EATING_OUT),
			tx(8302, "2026-10-04", "Trader Joe's", 8217, GROCERIES),
			tx(8303, "2026-10-03", "Costco", 14260, GROCERIES),
			tx(8304, "2026-09-30", "Trader Joe's", 6140, GROCERIES),
			tx(8305, "2026-09-30", "Shell", 3825, GAS),
			tx(8306, "2026-09-29", "Blue Bottle Coffee", 650, EATING_OUT),
		]}
		checked={[8301, 8303, 8304]}
		bar={<SelectBar selected={3} link="Select all 340 in all months" />}
	/>
);

/** B: one plain "Select all" that ticks the page, so the page's 25 are all that's selected. */
const selectPageOnly = (
	<SelectScreen
		count={IN_OCTOBER}
		rows={october(8400)}
		checked={[8401, 8402, 8403, 8404, 8405, 8406]}
		bar={<SelectBar selected={25} link="Select all" />}
	/>
);

// ---------------------------------------------------------------------------------------------
// P82: Save in a form with no sheet (question 45; P72 A). Settings' rename row and the feedback
// page, drawn in P72 A's quiet ledger pattern.

const PRIVACY_END =
	"This is best-effort redaction, not a guarantee that a report contains no personal information.";
const PRIVACY_TAIL = `It cannot reliably identify arbitrary names or every sensitive detail in prose; inspect the text and remove anything you do not want to send. The Worker repeats redaction before storage and private GitHub filing. New feedback records do not include your sign-in email. A random one-hour limiter cookie provides a best-effort per-browser rate limit; it can be cleared and is not a person-level identity or security boundary. Tally stores the report type, feeling, cleaned message, approved route category, coarse device category, and submission time in Cloudflare D1. Private GitHub filing receives the cleaned report fields without the sign-in email or submission time. ${PRIVACY_END}`;

/** A ledger-line text area (prototype, like LedgerField): a small muted label, the text on a rule. */
function LedgerArea({
	id,
	label,
	value,
	hint,
}: {
	id: string;
	label: string;
	value: string;
	hint: string;
}) {
	return (
		<div class="flex flex-col gap-1">
			<label for={id} class="text-sm text-muted">
				{label}
			</label>
			<div class="border-b border-muted has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-accent">
				<textarea
					id={id}
					name="message"
					rows={4}
					aria-describedby={`${id}-hint`}
					class="min-h-24 w-full resize-none bg-transparent text-lg focus-visible:outline-none"
				>
					{value}
				</textarea>
			</div>
			<p id={`${id}-hint`} class="text-sm text-muted">
				{hint}
			</p>
		</div>
	);
}

const TYPES = ["Bug", "Idea", "Question", "Other"];
const FEELINGS = ["Frustrated", "Confused", "Okay", "Happy", "Delighted"];

/** The feedback form's fields in the quiet pattern: two rows that open in place, and the message. */
function FeedbackFields({ id }: { id: string }) {
	return (
		<div class="flex flex-col gap-5">
			<div class="border-t border-rule">
				<Row label="What is it?" value={<span class="text-lg">Idea</span>}>
					<fieldset class="pb-3">
						<legend class="sr-only">What is it?</legend>
						<div class="flex flex-wrap gap-2">
							{TYPES.map((t) => (
								<Chip
									type="radio"
									name={`${id}-type`}
									value={t}
									checked={t === "Idea"}
								>
									{t}
								</Chip>
							))}
						</div>
					</fieldset>
				</Row>
				<Row
					label="How does Tally feel right now?"
					value={<span class="text-lg">Okay</span>}
				>
					<fieldset class="pb-3">
						<legend class="sr-only">How does Tally feel right now?</legend>
						<div class="flex flex-wrap gap-2">
							{FEELINGS.map((f) => (
								<Chip
									type="radio"
									name={`${id}-feeling`}
									value={f}
									checked={f === "Okay"}
								>
									{f}
								</Chip>
							))}
						</div>
					</fieldset>
				</Row>
			</div>
			<LedgerArea
				id={`${id}-message`}
				label="Message"
				value="The Costco row says Groceries, but I picked Household."
				hint="Automatic redaction can miss names and identifying details in ordinary prose. Review the cleaned text before sending."
			/>
		</div>
	);
}

/** A: the page scrolled to its end, with Cancel and Send after the last field, not pinned. */
const feedbackAtEnd = (
	<>
		<p class="text-muted">{PRIVACY_END}</p>
		<div class="mt-6 flex flex-col gap-5">
			<FeedbackFields id="p82-a" />
			<Footer save="Send" />
		</div>
	</>
);

/** B: the page part-way down, with Cancel and Send in a bar pinned to the bottom of the screen. */
const feedbackPinned = (
	<div class="relative -mx-5 h-[686px] overflow-hidden">
		<div class="px-5">
			<p class="text-muted">{PRIVACY_TAIL}</p>
			<div class="mt-6">
				<FeedbackFields id="p82-b" />
			</div>
		</div>
		<div class="absolute inset-x-0 bottom-0 border-t border-rule bg-paper px-5 pb-5 pt-3">
			<Footer save="Send" />
		</div>
	</div>
);

/** A row of Settings' category list, as it draws one: icon, name, "$600 a month", a chevron. */
function CategoryRow({
	cat,
	budget,
	open,
	children,
}: {
	cat: Cat;
	budget: string;
	open?: boolean;
	children?: Child;
}) {
	return (
		<details class="group border-b border-rule" open={open}>
			<summary class="flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 [&::-webkit-details-marker]:hidden">
				<CategoryIcon icon={cat.icon} color={cat.color} />
				<span class="min-w-0 truncate text-lg font-medium">{cat.name}</span>
				<span class="ml-auto shrink-0 tabular-nums">
					{budget}
					<span class="text-muted"> a month</span>
				</span>
				<Chevron />
			</summary>
			{children}
		</details>
	);
}

/** A: Settings' rename row open, in the quiet pattern; Save and Cancel stay at the end of the row. */
const renameRow = (
	<>
		<h1 class={TITLE}>Settings</h1>
		<section class="mt-8" aria-labelledby="p82-categories">
			<h2 id="p82-categories" class="font-serif text-3xl font-semibold">
				Categories
			</h2>
			<div class="mt-3 border-t border-rule">
				<CategoryRow cat={GROCERIES} budget="$600" />
				<CategoryRow cat={EATING_OUT} budget="$300" open>
					<div class="flex flex-col gap-4 pb-5 sm:pl-11">
						<LedgerField
							id="p82-rename-name"
							name="name"
							label="Name"
							value="Eating Out"
						/>
						<p class="text-muted">
							<a
								href="#p82-form-no-sheet"
								class="inline-flex min-h-11 items-center"
							>
								Change its budget on Home
							</a>
						</p>
						<div class="flex flex-wrap items-center gap-3">
							<Button type="button">Save</Button>
							<Button kind="secondary" type="button">
								Cancel
							</Button>
							<Button kind="text" type="button" class="ml-auto">
								Archive
							</Button>
						</div>
						<div class="flex flex-wrap gap-2">
							<Button kind="secondary" type="button" class="gap-2">
								<Icon name="arrow-up" class="size-4" />
								Move up
							</Button>
							<Button kind="secondary" type="button" class="gap-2">
								<Icon name="arrow-down" class="size-4" />
								Move down
							</Button>
						</div>
					</div>
				</CategoryRow>
				<CategoryRow cat={KIDS} budget="$250" />
				<CategoryRow cat={HOUSEHOLD} budget="$180" />
			</div>
		</section>
	</>
);

// ---------------------------------------------------------------------------------------------
// P83 and P84: Add a bill in P72 A's quiet ledger form (the amount as the one big thing, Name and
// Due on lines, Category and "Match payments from" folded into rows, Cancel and Save pinned).

type QuietBillProps = {
	id: string;
	bill: Bill;
	/** The amount's alert line (P45 A's over-$100,000 line). */
	amountError?: string;
	/** Drawn right under the amount. */
	afterAmount?: Child;
	/** The "Match payments from" row. */
	match: Child;
	/** What's pinned under the form. */
	footer?: Child;
};

/** P72 A's Add a bill, as BillA draws it, with the pieces these two questions change given. */
function QuietBill(props: QuietBillProps) {
	const { id, bill: b } = props;
	return (
		<TallSheet
			behind={billsBehind}
			footer={props.footer ?? <Footer save="Save" />}
			gap="gap-3"
		>
			<h2 class="font-serif text-2xl font-semibold tracking-tight">
				Add a bill
			</h2>
			<LedgerField
				big
				prefix="$"
				id={`${id}-amount`}
				name="amount"
				label="Amount"
				value={b.amount}
				inputmode="decimal"
				error={props.amountError}
			/>
			{props.afterAmount}
			<LedgerField id={`${id}-name`} name="name" label="Name" value={b.name} />
			<DueRow id={id} bill={b} lead="Due on the" />
			<div class="border-t border-rule">
				<Row label="Category" value={categoryValue(b.category)}>
					<CategoryChips id={id} selected={b.category} />
				</Row>
				{props.match}
			</div>
		</TallSheet>
	);
}

/** The field inside the row: the bank's text for the payment, with how Tally uses it. */
function MatchField({ id, hint }: { id: string; hint: string }) {
	return (
		<div class="pb-3">
			<LedgerField
				id={`${id}-match`}
				name="merchant_raw_name"
				label="Match payments from"
				hideLabel
				value=""
				hint={hint}
			/>
		</div>
	);
}

/** P83 A: closed, saying there's nothing yet and what will fill it in. */
function NoneYetRow({ id }: { id: string }) {
	return (
		<details class="group border-b border-rule">
			<summary class={summaryRow}>
				<span class="flex min-w-0 flex-col py-1">
					<span class="text-muted">Match payments from</span>
					<span class="text-sm text-muted">
						The first payment you link fills it in.
					</span>
				</span>
				<span class="ml-auto shrink-0 text-muted">None yet</span>
				<Chevron />
			</summary>
			<MatchField
				id={id}
				hint="How your bank writes it. Tally uses it to match payments to this bill."
			/>
		</details>
	);
}

const BIG_RENT: Bill = { ...RENT, amount: "150000.00" };
const TOO_BIG = "$150,000.00 is a lot for a bill.";

/** P84's chip, as P45 A drew it: ticked to say the amount is right. */
function ConfirmChip({ id }: { id: string }) {
	return (
		<div>
			<Chip
				type="checkbox"
				name={`${id}-confirm`}
				value="15000000"
				describedBy={`${id}-amount-error`}
			>
				Yes, $150,000.00 is right
			</Chip>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// P85: desktop's side panel entering (question 51; P74 A's motion). The window is drawn 1024 wide,
// the narrowest desktop layout, at 70%, so the page and the 28 rem panel are both in the picture.

type Enter = "slide" | "fade";

/**
 * The Transactions page on desktop with Costco's panel opening over it, looping at the real 200 ms
 * with a pause: the panel and its backdrop carry the real classes from app.css (sheet-slide, which
 * BottomSheet's own class becomes at desktop width, and fade-in), and the stage's loop replays them.
 * At rest it shows the end state.
 */
function DesktopPanel({ enter }: { enter: Enter }) {
	return (
		<div class="proposal-loop proposal-200 relative -mx-[105px] -mt-8 h-[560px] w-[722px] overflow-hidden">
			<div class="relative h-[794px] w-[1024px] origin-top-left scale-[0.705] bg-paper">
				<div class="mx-auto flex max-w-6xl gap-10 px-8">
					<aside class="w-56 shrink-0 py-8">
						<div class="mb-6">
							<Wordmark />
						</div>
						<ul class="flex flex-col gap-1">
							{SIDEBAR_ITEMS.map((item) => (
								<li
									class={`flex min-h-11 items-center gap-3 rounded-control px-2 text-lg ${item.key === "transactions" ? "text-accent" : "text-ink"}`}
								>
									<Icon name={item.icon} />
									{item.label}
								</li>
							))}
						</ul>
					</aside>
					<div class="min-w-0 flex-1 pt-8">
						<TxHeader />
						<p class="mt-4 text-sm text-muted">18 transactions in October</p>
						<div class="mt-2">
							<Days
								rows={[
									BLUE_BOTTLE,
									TRADER_JOES,
									LUPITAS,
									COSTCO,
									AMAZON,
									SHELL,
								]}
							/>
						</div>
					</div>
				</div>
				<div class="fade-in absolute inset-0 bg-ink/30" />
				<div
					class={`absolute inset-y-0 right-0 flex w-[28rem] flex-col gap-3 rounded-l-sheet bg-paper p-5 ${enter === "slide" ? "sheet-slide" : "fade-in"}`}
				>
					<PanelTop
						row={COSTCO}
						raw="COSTCO WHSE #0412"
						account="Chase Card ••9921"
					/>
					<PanelForm>
						<Categories p={`p85-${enter}`} cats={FIVE} selected="Groceries" />
						<Toggles p={`p85-${enter}`} />
						{actions}
					</PanelForm>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// P86: clearer words for the AI switches (question 2, P41 B). Three sets of names and lines for the
// four switches, each drawn on P41 B's switch, then again with Categories and Income off.

type SwitchWords = {
	features: Feature[];
	/** The line under the last switch when it is greyed out (question 2). */
	needs: string;
};

/** Said once for every option, so the pictures differ only in the switches' own words. */
export const SWITCH_GROUP_LINE =
	"Tally only suggests; you can change anything it does. Off means your choices and rules only.";

export const SAY_WHAT_IT_DOES: SwitchWords = {
	features: [
		{
			id: "names",
			name: "Suggest store names",
			line: "Turns bank text like SQ *BLUE BOTTLE COF into Blue Bottle Coffee. You pick the name.",
		},
		{
			id: "categories",
			name: "Guess categories",
			line: "Puts a transaction in a category when Tally is sure, and leaves transfers between your accounts out of the budget.",
		},
		{
			id: "income",
			name: "Spot paychecks",
			line: "Marks money coming in as income when Tally is sure.",
		},
		{
			id: "arrival",
			name: "Sort right away",
			line: "Sorts new transactions as soon as the bank sends them, not overnight.",
		},
	],
	needs: "Needs Guess categories or Spot paychecks on.",
};

const B_QUESTION_EACH: SwitchWords = {
	features: [
		{
			id: "names",
			name: "Suggest names for stores?",
			line: "Tally offers a clean name for bank text, and you pick it.",
		},
		{
			id: "categories",
			name: "Guess categories?",
			line: "Tally picks a category when it's sure, and keeps transfers and reimbursements out of your budget.",
		},
		{
			id: "income",
			name: "Spot paychecks?",
			line: "Tally marks money coming in as income when it's sure.",
		},
		{
			id: "arrival",
			name: "Sort as soon as transactions arrive?",
			line: "Tally sorts them right after your bank sends them, not only overnight.",
		},
	],
	needs: "Needs “Guess categories?” or “Spot paychecks?” on.",
};

const TODAYS_NAMES: SwitchWords = {
	features: [
		{
			id: "names",
			name: "Merchant names",
			line: "Offers a clean name for the text your bank sends. You pick the name.",
		},
		{
			id: "categories",
			name: "Categories and exclusions",
			line: "Picks a category when Tally is sure, and leaves transfers and money you were paid back out of your budget.",
		},
		{
			id: "income",
			name: "Income",
			line: "Marks money coming in, like a paycheck, as income when Tally is sure.",
		},
		{
			id: "arrival",
			name: "Sort new transactions as they arrive",
			line: "Sorts them right after your bank sends them, not only overnight.",
		},
	],
	needs: "Needs Categories and exclusions or Income on.",
};

/**
 * Settings' AI suggestions group as P41 B draws it, in one option's words: all on to start, or
 * (greyed) with Categories and Income off, so the last switch has nothing to sort and is greyed out,
 * still showing its saved On.
 */
function AiWords({ words, greyed }: { words: SwitchWords; greyed?: boolean }) {
	return (
		<AiGroup intro={SWITCH_GROUP_LINE}>
			<ul class="mt-3 divide-y divide-rule border-y border-rule">
				{words.features.map((f) => (
					<SwitchRow
						f={f}
						on={!greyed || f.id === "names" || f.id === "arrival"}
						needs={greyed && f.id === "arrival" ? words.needs : undefined}
					/>
				))}
			</ul>
			<div class="mt-4">
				<Button type="button">Save</Button>
			</div>
		</AiGroup>
	);
}

// ---------------------------------------------------------------------------------------------
// P87: how a name Tally guessed shows (question 10; P29 A's list and panel, P42 A's question).
// Blue Bottle Coffee is a name the bank sent (Plaid's merchant_name, so Workers AI is never asked);
// Lupita's Taqueria and Amazon are names the bank didn't send, so Tally guesses. Each option is
// drawn on the list, the edit panel and the review screen. The Suggest store names switch off is
// drawn once, because it reads the same in every option.

/** A: P32's dashed pill, the one look every guess has, now saying whose guess it is. */
function GuessTag() {
	return (
		<span class="shrink-0 rounded-control border border-dashed border-ink px-2 text-sm leading-5 text-ink">
			Tally's guess
		</span>
	);
}

/** B, in the list: the sparkles icon before the name, and the words for a screen reader. */
const guessMark = (
	<>
		<Icon name="sparkles" class="size-4 shrink-0" />
		<span class="sr-only">Tally's guess: </span>
	</>
);

/** A guess's label in the panel and on the review screen, with the Why? that explains it. */
function GuessLine({ children }: { children?: Child }) {
	return (
		<div class="flex flex-wrap items-center gap-x-2 text-sm">
			{children}
			<Why topic="Tally's guess" href="#p87-name-source" />
		</div>
	);
}

const guessTagLine = (
	<GuessLine>
		<GuessTag />
	</GuessLine>
);

const guessIconLine = (
	<GuessLine>
		<span class="inline-flex items-center gap-1.5 text-ink">
			<Icon name="sparkles" class="size-4" />
			Tally's guess
		</span>
	</GuessLine>
);

/** The bank's own name says where it came from quietly: muted words, no tag and nothing to explain. */
const fromBank = <p class="text-sm text-muted">From your bank</p>;

/** How the list draws a name Tally guessed: with A's tag, B's icon, or (C, and switch off) not at all. */
type Look = "tag" | "icon" | "tidied";

/** A merchant the bank sent no name for: Tally's guess, and the tidied bank text a person sees without it. */
const GUESSES = [
	{
		guess: "Lupita's Taqueria",
		tidied: "Lupitas taq",
		cents: 2240,
		cat: CATS.eatingOut,
	},
	{ guess: "Amazon", tidied: "Amzn mktp", cents: 3418, cat: CATS.household },
];

/**
 * The Transactions list: a row for each kind of name. Blue Bottle is the bank's own (dashed like
 * every suggestion, but never tagged), Trader Joe's is a name someone kept, and Lupita's and Amazon
 * are Tally's guesses, drawn as `look` says.
 */
function NamesList({ look }: { look: Look }) {
	const [lupitas, amazon] = GUESSES.map((g) =>
		look === "tidied" ? (
			<SuggestedRow name={g.tidied} plain cents={g.cents} cat={g.cat} />
		) : (
			<SuggestedRow
				name={g.guess}
				cents={g.cents}
				cat={g.cat}
				mark={look === "icon" ? guessMark : undefined}
				tag={look === "tag" ? <GuessTag /> : undefined}
			/>
		),
	);
	return (
		<>
			<Title>Transactions</Title>
			<p class="mt-2 text-muted">Dashed names are suggestions.</p>
			<ul class="mt-2 divide-y divide-rule">
				<SuggestedRow
					name="Blue Bottle Coffee"
					cents={650}
					cat={CATS.eatingOut}
				/>
				{lupitas}
				<SuggestedRow
					name="Trader Joe's"
					plain
					cents={8217}
					cat={CATS.groceries}
				/>
				{amazon}
			</ul>
		</>
	);
}

/**
 * The edit panel's name part, in the taller sheet so Save shows: the bank's text and the amount,
 * then the name choices, which say under the suggestions where they came from (`source`).
 */
function NamePanel({
	raw,
	amount,
	children,
}: {
	raw: string;
	amount: string;
	children?: Child;
}) {
	return (
		<TallSheet
			behind={transactionsBehind}
			footer={<Footer save="Save" />}
			gap="gap-3"
		>
			<div>
				<p class="text-sm text-muted">{raw}</p>
				<p class="font-serif text-4xl font-semibold">{amount}</p>
			</div>
			{children}
		</TallSheet>
	);
}

/** The panel for Lupita's Taqueria, a name Tally guessed; `source` says so under the names. */
function GuessPanel({ id, source }: { id: string; source: Child }) {
	return (
		<NamePanel raw="TST* LUPITAS TAQ" amount="−$22.40">
			<NameChoices
				id={id}
				names={["Lupita's Taqueria", "Lupita's"]}
				keep="Lupitas taq"
				count={2}
				source={source}
			/>
		</NamePanel>
	);
}

/** The panel for Blue Bottle Coffee, the bank's own name: offered, and labelled quietly. */
const bankPanel = (
	<NamePanel raw="SQ *BLUE BOTTLE COF 0412" amount="−$6.50">
		<NameChoices
			id="p87-off-panel"
			names={["Blue Bottle Coffee"]}
			source={fromBank}
		/>
	</NamePanel>
);

/** A name question on the review screen: Lupita's (Tally's guess) or Blue Bottle (the bank's). */
function NameQuestion({
	id,
	of,
	source,
}: {
	id: string;
	of: "guess" | "bank";
	/** The line under the question that says where the name came from. */
	source: Child;
}) {
	const guess = of === "guess";
	return (
		<>
			<ReviewHead
				place={guess ? "4 of 14" : "2 of 9"}
				name={guess ? "Lupitas taq" : "Blue bottle cof"}
				bank={guess ? "TST* LUPITAS TAQ" : "SQ *BLUE BOTTLE COF 0412"}
				meta={guess ? "2 transactions · $44.80" : "9 transactions · $58.50"}
			/>
			<Question icon={<Icon name="tag" class="size-7" />} source={source}>
				{guess ? "Lupita's Taqueria" : "Blue Bottle Coffee"}
			</Question>
			<Answers
				yes={`Yes, ${guess ? "Lupita's Taqueria" : "Blue Bottle Coffee"}`}
			>
				<ElseNames
					id={id}
					names={guess ? ["Lupitas Taqueria", "Lupita's"] : []}
					keep={guess ? "Lupitas taq" : "Blue bottle cof"}
				/>
			</Answers>
		</>
	);
}

/** P76–P87 on the proposals page, picked (decision 80). */
export function DetailsProposals() {
	return (
		<>
			<Specimen
				id="p76-maybe-income"
				title="P76 · Where “Maybe income” shows"
				tier="visual"
				sentence="Tally can guess that money in is a paycheck without being sure enough to count it. Pick where that guess shows. Each is drawn with Acme Payroll, $2,450.00."
			>
				<Fixed>
					question 5, on decisions 64 and 73. Below the threshold an income
					answer shows as “Maybe income” (§8.6), the same dashed tag as every
					other “Maybe …”, and each is asked on one review screen, one yes-or-no
					question at a time (P42 A). A category guess already shows dashed on
					its row and in the panel with “Tally's guess · N% sure” (P32 A). A
					bank credit nobody has identified is held out of spending (decision
					70), and a person's choice always wins (§8.5).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · On the row",
							picked: true,
							note: "A dashed “Maybe income” takes the place of “Review credit” on the row, the dashed look “Maybe Eating Out” already has. The panel and the review screen carry it too (next two pictures).",
							tradeoff: "the guess is in three places to keep in step.",
							recommended:
								"it's the same “Maybe …” everywhere, so the guess is seen where the family already is, and nothing counts until someone says yes.",
							screen: <PayList pay={<MaybeIncomeRow />} />,
						},
						{
							name: "Option A, next · In the edit panel",
							note: "“Count as income” is dashed, with “Tally's guess · 71% sure” and a Why? under it, as a category guess has.",
							screen: maybeIncomePanel,
						},
						{
							name: "Option B · The review screen only",
							note: "The list and the panel stay as they are today: the row says “Review credit” and the panel has no guess. The guess waits on the review screen.",
							tradeoff:
								"someone who opens the credit sees no guess, and learns Tally had one only from the Band on Settings.",
							screen: <PayList pay={<TransactionRow row={PAY} />} />,
						},
						{
							name: "Both · The review screen",
							note: "Every “Maybe …” is asked here, one yes-or-no question at a time: “Yes, it's income” counts it, “No” keeps it out.",
							screen: askIncome,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p77-switch-off"
				title="P77 · A switched-off feature in “What AI did”"
				tier="visual"
				sentence="“What AI did” counts what each AI feature did this month. Pick what its line says when a feature is switched off. Each is drawn with Income switched off, scrolled to the switches."
			>
				<Fixed>
					question 20, on decisions 73 and 68. The AI suggestions group is
					switches with On or Off in words and one Save (P41 B), and “What AI
					did” is an “In October” tally under it with a Why? link (P43 A). Off
					means Tally works from rules and people's choices alone, and nothing
					already decided changes (§8.6).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · The line says Off",
							picked: true,
							note: "The paychecks line stays, in muted words: “Paychecks · Off”, beside a switch that says Off too.",
							tradeoff: "a line with no number in a list of numbers.",
							recommended:
								"the tally always has the same lines, so nothing looks missing, and the word is the one the switch uses.",
							screen: (
								<AiDidScreen
									income={<li class="text-muted">Paychecks · Off</li>}
								/>
							),
						},
						{
							name: "Option B · The line is left out",
							note: "Only the features that are on are counted, so the list is two lines.",
							tradeoff:
								"the tally changes shape when a switch does, and with every switch off “In October” has nothing under it.",
							screen: <AiDidScreen income={null} />,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p78-part-paid"
				title="P78 · “Part paid” before it's overdue"
				tier="visual"
				sentence="A bill that's partly paid says how much. Pick where it sits while it isn't late yet. Each is drawn with Rent, $1,200, $600 paid, due on the 7th."
			>
				<Fixed>
					question 28, on decision 74 (P58 A). Several payments can pay one
					occurrence, which is Paid once they add up to at least 90% of its
					amount; a part-paid bill says “Part paid: $600 of $1,200” on its row
					and sets aside only what's left. A bill is Overdue once its due date
					has passed, Due in the next 7 days within a week, and Upcoming
					otherwise (§6).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Where its date puts it",
							picked: true,
							note: "Rent stays in Due in the next 7 days, its row saying “Part paid: $600 of $1,200”. After the 7th it moves to Overdue with the same words, as P58 A drew it.",
							tradeoff:
								"the heading says it's due and the row says it's part paid: two things about one bill.",
							recommended:
								"a part-paid bill is as late as any other, so the date decides its group and the row adds what's paid.",
							screen: partPaidWhereItIs,
						},
						{
							name: "Option B · A Part paid group",
							note: "A group of its own above the rest, headed “Part paid” like Overdue, with the alert icon and the words, however far off the due date is.",
							tradeoff:
								"an alert group for a bill that isn't late reads as blame, and the group says nothing about when it's due.",
							screen: partPaidOwnGroup,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p79-bill-category-line"
				title="P79 · The category from a bill"
				tier="visual"
				sentence="A payment linked by the matcher or by hand takes its bill's category over a Tally pick or an earlier bill's, while preserving a person's or merchant rule's choice. Pick how the edit panel explains it."
			>
				<Fixed>
					question 29, on decision 74 (P59 A). A payment linked by the matcher
					or by hand takes its bill's category over a Jev pick or an earlier
					bill's; a person's or merchant rule's category stays. The row's
					caption says “Rent · paid Rent bill”. When Tally picked a category the
					panel already says so in a muted line under the chips, “Picked by
					Tally · N% sure” (§7), and a person's choice or a merchant rule shows
					nothing extra.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · A muted line under the chips",
							note: "“Category from the Rent bill”, small and muted, in the place and the voice of “Picked by Tally · 64% sure”.",
							tradeoff: "one more line in a panel that's already full.",
							recommended:
								"it answers “why Rent?” where the question comes up, in the same words as Tally's own picks.",
							screen: (
								<RentPanel p="p79-a" line="Category from the Rent bill" />
							),
						},
						{
							name: "Option B · Nothing in the panel",
							note: "The panel shows Rent chosen and nothing else. Only the row's caption says where it came from.",
							tradeoff:
								"the panel can't say why a payment is in Rent, and the caption is on the list only.",
							screen: <RentPanel p="p79-b" />,
						},
						{
							name: "Option C · A link to the bill",
							note: "Under the day line, “Paid the Rent bill”, with “Rent bill” a terracotta link to the bill's page. Nothing is added under the chips.",
							tradeoff:
								"it doubles as navigation, so a tap leaves the panel, and it says the bill was paid, not that Rent came from it.",
							screen: <RentPanel p="p79-c" lineEnd={paidTheBill} />,
						},
						{
							name: "Option D · A mark on the chip",
							note: "The chosen chip carries a small bills icon and reads “Rent · from the bill”, marked as P32's “Suggested” marks a guess. Nothing else is added.",
							tradeoff:
								"it crowds the chip, and it only shows while that chip is chosen.",
							screen: <RentPanel p="p79-d" selectedEnd={fromTheBill} />,
						},
						{
							name: "Option E · A Why? link",
							picked: true,
							note: "A terracotta “Why?” follows the label “Category” and leads to How Tally works, as the Why? beside a guess does. Its categorization section says a payment linked by the matcher or by hand takes the bill's category when it has none, a Tally pick or an earlier bill's category, while a person's choice or a merchant rule is never replaced and unlinking leaves the category.",
							tradeoff:
								"it hides the answer behind a tap, on another page, and the panel itself never says a bill was involved.",
							screen: (
								<RentPanel
									p="p79-e"
									labelEnd={
										<WhyLink section="categorization" topic="this category" />
									}
								/>
							),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p80-rules-search"
				title="P80 · Finding one in “Always for these merchants”"
				tier="visual"
				sentence="Organize makes a rule for every merchant it sorts, so this list grows. Pick how to find one. Each is drawn with 34 merchants."
			>
				<Fixed>
					question 40, on decision 74 (P69 A). The section is called “Always for
					these merchants”, and each row names the merchant, its category and
					how many transactions it has sorted, with Remove. Organize makes a
					rule for every merchant it sorts (§8.1), so the list can be long. A
					count above a filtered list names the filter (DESIGN.md, Result
					count).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · A–Z, with a search box",
							picked: true,
							note: "Merchants A to Z. With 20 or fewer there is no search box; with more, a box above the list filters it by name, and the count says what's shown (next picture).",
							tradeoff:
								"one more control, though only once the list is long enough to need it.",
							recommended:
								"a family finds a merchant by the one thing they know, its name, and a short list stays plain.",
							screen: rulesAToZ(
								"p80-a-q",
								"",
								"34 merchants, A to Z",
								RULES_A_TO_Z,
							),
						},
						{
							name: "Option A, next · After typing “co”",
							note: "The list narrows to names with “co” in them, and the count names the search.",
							screen: rulesAToZ("p80-a2-q", "co", "4 merchants matching “co”", [
								BLUE_BOTTLE_RULE,
								COSTCO_RULE,
								COSTCO_GAS,
								DISCOUNT_TIRE,
							]),
						},
						{
							name: "Option B · Grouped by category",
							note: "The merchants sit under their category's name, which says it once for all of them, so each row is the merchant and its count.",
							tradeoff:
								"you have to know a merchant's category to find it, and with many categories the page is long.",
							screen: rulesGrouped,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p81-select-all"
				title="P81 · Select all's words"
				tier="visual"
				sentence="Select all can tick this page or everything the filters match. Pick what it says. Each is drawn with 112 transactions in October."
			>
				<Fixed>
					question 41, on decision 74 (P70 A). Select mode has Set category and
					Exclude on a bar pinned at the bottom (§8.2), and Select all goes in
					that bar beside the count, a line that says how many are selected and
					is announced when it changes.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · The link says how many",
							picked: true,
							note: "“Select all 112 in October” ticks every transaction the filters match, not only this page, and says so in its words.",
							tradeoff:
								"a long link in a bar that already has a count and two buttons.",
							recommended:
								"it says what it will do before you tap, so nobody changes 87 transactions they didn't see.",
							screen: selectLink,
						},
						{
							name: "Option A, next · After unticking one",
							note: "Every one was ticked, then one was unticked: the rest stay ticked and the count says “111 selected”. The link is still there to tick it again.",
							screen: selectOneOff,
						},
						{
							name: "Option A, next · With All months",
							note: "The same words name the months: “Select all 340 in all months”.",
							screen: selectAllMonths,
						},
						{
							name: "Option B · A single “Select all”",
							note: "One plain “Select all” that ticks this page's 25. The count above still says 112.",
							tradeoff:
								"“all” means 25, and only the count above the list says the other 87 aren't selected.",
							screen: selectPageOnly,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p82-form-no-sheet"
				title="P82 · Save in a form with no sheet"
				tier="visual"
				sentence="Add a bill's Save is pinned in its sheet. Settings' rename row and the feedback page aren't in a sheet. Pick where their Save goes. The feedback page is drawn in the family app, in the quiet ledger pattern."
			>
				<Fixed>
					question 45, on decisions 75 and 72. Every form follows the quiet
					ledger pattern (P72 A), with Cancel and Save pinned so they're always
					visible (§8.7), which P72 drew in a sheet's footer. Today Settings'
					Save and Cancel sit on one line at the end of the open row, with
					Archive at the far right (DESIGN.md).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Save at the end of the form",
							picked: true,
							note: "Cancel and Send follow the last field, not pinned. Drawn with the page scrolled to its end.",
							tradeoff:
								"on a long page you scroll to find Send, as you do today.",
							recommended:
								"the form is the page, so its buttons come after its last field, where Save already is on Settings, and nothing covers the page.",
							family: true,
							screen: feedbackAtEnd,
						},
						{
							name: "Option A, next · Settings' rename row",
							note: "The same on the rename row: the name on a ledger line, then Save and Cancel with Archive at the far right, as the row has them today.",
							screen: renameRow,
						},
						{
							name: "Option B · A pinned bar",
							note: "Cancel and Send in a bar fixed to the bottom of the screen, as in a sheet. Drawn part-way down the page, with the form running under the bar.",
							tradeoff:
								"the bar covers the bottom of the page, shows Send before there's a message to send, and on Settings it would sit far from the row you're renaming.",
							family: true,
							screen: feedbackPinned,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p83-match-empty"
				title="P83 · An empty “Match payments from”"
				tier="visual"
				sentence="A bill added by hand has no payment yet, so “Match payments from” has nothing in it. Pick how the empty row looks. Each is drawn on Add a bill."
			>
				<Fixed>
					question 46, on decisions 74 and 75. A bill's “Match payments from” is
					optional, and the first payment linked by hand fills it in (decision
					74). In the quiet form it is a row that opens in place, with the
					bank's text muted when Tally has filled it in (P72 A).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Closed, saying None yet",
							picked: true,
							note: "The row stays closed: “Match payments from · None yet”, and under it “The first payment you link fills it in.”",
							tradeoff:
								"someone who knows the bank's text has one more tap to type it.",
							recommended:
								"nothing is asked of you, and the row says how it fills in.",
							screen: (
								<QuietBill
									id="p83-a"
									bill={RENT}
									match={<NoneYetRow id="p83-a" />}
								/>
							),
						},
						{
							name: "Option B · Open, with an empty field",
							note: "The row opens itself with an empty field and a hint.",
							tradeoff:
								"an empty box reads as a blank to fill in on a form, so a first bill looks harder than it is, and the sheet is taller.",
							screen: (
								<QuietBill
									id="p83-b"
									bill={RENT}
									match={
										<Row label="Match payments from" open>
											<MatchField
												id="p83-b"
												hint="Optional. How your bank writes it. Tally uses it to match payments to this bill."
											/>
										</Row>
									}
								/>
							),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p84-big-amount-chip"
				title="P84 · The over-$100,000 chip in the quiet Add a bill"
				tier="visual"
				sentence="Add a bill asks you to tick “Yes, $150,000.00 is right” before it saves an amount that big. Pick where the chip sits in the quiet form. Each is drawn with Rent typed with two zeros too many."
			>
				<Fixed>
					question 47, on decisions 72 and 75. A bill over $100,000 saves only
					once a “Yes, $X is right” chip is ticked (P45 A, §8.5), with a line
					under the amount saying why. The quiet form has a plain big amount
					field and pins Cancel and Save in a footer (P72 A).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Under the amount's line",
							picked: true,
							note: "The chip sits right under “$150,000.00 is a lot for a bill.”, in the form, as P45 A had it.",
							tradeoff: "the form is a chip taller, so less of it is in view.",
							recommended:
								"the question and its answer are together, next to the number they're about.",
							screen: (
								<QuietBill
									id="p84-a"
									bill={BIG_RENT}
									amountError={TOO_BIG}
									afterAmount={<ConfirmChip id="p84-a" />}
									match={<MatchRow id="p84-a" paidTo={RENT.paidTo} />}
								/>
							),
						},
						{
							name: "Option B · In the footer with Save",
							note: "The chip sits in the pinned footer above Save, so the line under the amount says why and the tick is by the button it unlocks.",
							tradeoff:
								"the footer is two rows tall on a phone, and the tick is far from the amount it's about.",
							screen: (
								<QuietBill
									id="p84-b"
									bill={BIG_RENT}
									amountError={TOO_BIG}
									match={<MatchRow id="p84-b" paidTo={RENT.paidTo} />}
									footer={
										<div class="flex flex-col gap-3">
											<ConfirmChip id="p84-b" />
											<Footer save="Save" />
										</div>
									}
								/>
							),
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p85-desktop-panel"
				title="P85 · Desktop's side panel entering"
				tier="visual"
				sentence="On a wide screen the edit panel opens on the right. Pick how it arrives. Each picture loops at its real speed, 200 ms, with a pause between; if nothing moves for you, your device is set to reduce motion, and each rests on its end state."
			>
				<Fixed>
					question 51, on decision 76 (P74 A). Motion is CSS only, each move
					over in 150 to 200 ms, a sheet rises in 200 ms as its backdrop fades
					in, and reduced motion shows the end state without moving (DESIGN.md,
					Motion). On desktop the sheet is a right-hand panel 28 rem wide over a
					dimmed backdrop, closed by Cancel or the backdrop.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Slides in from the right",
							picked: true,
							desktop: true,
							note: "The panel slides in from the right edge in 200 ms ease-out while the backdrop fades in, the desktop twin of the phone's sheet rising.",
							tradeoff:
								"a longer move on a wide screen: the panel travels its full 28 rem.",
							recommended:
								"the panel comes from the side it sits on, as the phone's sheet comes from the bottom it sits on.",
							screen: <DesktopPanel enter="slide" />,
						},
						{
							name: "Option B · Fades in place",
							desktop: true,
							note: "The panel and the backdrop fade in together in 200 ms, with nothing moving.",
							tradeoff:
								"calmest, but it doesn't say where the panel came from, and it isn't the phone's rise.",
							screen: <DesktopPanel enter="fade" />,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p86-switch-words"
				title="P86 · Clearer words for the AI switches"
				tier="visual"
				sentence="The names and lines under the four AI switches are confusing. Pick the words. Each option is drawn on Settings' AI suggestions group, then again with Categories and Income off, so the last switch is greyed out."
			>
				<Fixed>
					question 2, on decisions 68 and 73. The four switches do what §8.6
					says: names for merchants; a category, with transfers and
					reimbursements left out of the budget; income; and sorting new
					transactions right after a sync, not only overnight. All are on to
					start. Off means Tally works from your rules and choices alone, and
					nothing already decided changes. The look is P41 B's: switches made
					from real checkboxes, On or Off in words beside each, and one Save
					under the group. When Categories and Income are both off, the last
					switch is greyed out, with a line saying it needs one of them on (the
					owner's pick for question 2).
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · Say what it does for you",
							picked: true,
							note: "Each switch is named for its job, in the words the family uses, with an example where one helps: Suggest store names, Guess categories, Spot paychecks, Sort right away.",
							tradeoff:
								"the lines are longer than today's, so the group is taller and Save sits lower on the screen.",
							recommended:
								"each name is the job, in the words the family uses, with an example.",
							tall: true,
							screen: <AiWords words={SAY_WHAT_IT_DOES} />,
						},
						{
							name: "Option A, next · Categories and Income off",
							note: "Nothing is left to sort, so “Sort right away” is greyed out and says what it needs. It still shows its saved On, dimmed, and Save leaves it as it was.",
							tall: true,
							screen: <AiWords words={SAY_WHAT_IT_DOES} greyed />,
						},
						{
							name: "Option B · A question each",
							note: "Each switch is a question, with a one-line answer under it.",
							tradeoff:
								"the switch answers with On or Off, not Yes or No, and the last question is the longest name.",
							tall: true,
							screen: <AiWords words={B_QUESTION_EACH} />,
						},
						{
							name: "Option B, next · Categories and Income off",
							note: "The last question is greyed out, and says which two it needs.",
							tall: true,
							screen: <AiWords words={B_QUESTION_EACH} greyed />,
						},
						{
							name: "Option C · Today's names, clearer lines",
							note: "The four names stay as they are now. Only the lines under them are rewritten.",
							tradeoff:
								"“Categories and exclusions” and “Income” stay as the names, so the lines have all the explaining to do.",
							tall: true,
							screen: <AiWords words={TODAYS_NAMES} />,
						},
						{
							name: "Option C, next · Categories and Income off",
							note: "The last switch is greyed out, and says which two it needs.",
							tall: true,
							screen: <AiWords words={TODAYS_NAMES} greyed />,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p87-name-source"
				title="P87 · Where a suggested name comes from"
				tier="visual"
				sentence="A name Tally guessed should be unmistakably a guess, wherever it shows. Pick how it says so. Each option is drawn on the Transactions list, the edit panel and the review screen. Lupita's Taqueria and Amazon are names Tally guessed; Blue Bottle Coffee is a name your bank sent, and stays quieter. The last three pictures show Suggest store names switched off, which reads the same in every option."
			>
				<Fixed>
					question 10, on decisions 64 and 68. Plaid's name is the first
					suggestion and Workers AI only runs when Plaid sends none (decision
					68). A suggestion shows dashed until a person chooses (decision 64).
					Screens never name the AI service or Plaid's brand to the family:
					“your bank” is fine, and “Tally's guess” is how AI suggestions are
					named (decision 64). The owner's answer to question 10: help the
					family tell Tally's guess from the bank's own clean name. Their note
					on the first drawing: “I would prefer we make it more obvious that the
					AI suggested name is just that, an AI suggested name.” So a guess is
					drawn to be unmistakable wherever it shows, and the bank's own name
					stays quieter.
				</Fixed>
				<Options
					options={[
						{
							name: "Option A · A “Tally's guess” tag everywhere",
							note: "A small dashed “Tally's guess” tag follows a name Tally guessed, the same dashed pill as P32's “Maybe …” tags. In the list it sits right after the dashed name. Your bank's name gets no tag: it stays a plain dashed name.",
							tradeoff:
								"every guessed row carries the tag, which repeats a sign (DESIGN.md: a sign appears once), and on a phone a longer name pushes it onto a line of its own, as Lupita's does.",
							recommended:
								"the word says what it is, everywhere, in the same dashed look as every other guess.",
							screen: <NamesList look="tag" />,
						},
						{
							name: "Option A, next · The edit panel",
							note: "Under the suggested names, the tag sits after them, with a Why? that explains it. The bank's text, tidied, is kept below as before.",
							screen: <GuessPanel id="p87-a-panel" source={guessTagLine} />,
						},
						{
							name: "Option A, next · The review screen",
							note: "Your bank sent no name for Lupita's, so Tally guessed. The tag sits under the name, with the Why?.",
							screen: (
								<NameQuestion
									id="p87-a-review"
									of="guess"
									source={guessTagLine}
								/>
							),
						},
					]}
				/>
				<Options
					options={[
						{
							name: "Option B · An icon plus the words",
							picked: true,
							note: "A small sparkles icon comes before a name Tally guessed in the list. Your bank's name gets no icon.",
							tradeoff:
								"the icon has to be learned, and it reads as decoration.",
							screen: <NamesList look="icon" />,
						},
						{
							name: "Option B, next · The edit panel",
							note: "“Tally's guess” has the same icon beside it under the suggested names, with the Why?.",
							screen: <GuessPanel id="p87-b-panel" source={guessIconLine} />,
						},
						{
							name: "Option B, next · The review screen",
							note: "The same icon and words under the name, with the Why?.",
							screen: (
								<NameQuestion
									id="p87-b-review"
									of="guess"
									source={guessIconLine}
								/>
							),
						},
					]}
				/>
				<Options
					options={[
						{
							name: "Option C · Keep the tidied name in the list",
							note: "The list never shows a name Tally guessed until someone keeps it: Lupita's stays “Lupitas taq”, the bank's text tidied. Blue Bottle's own name is still dashed.",
							tradeoff:
								"the list reads like a bank statement until names are kept.",
							screen: <NamesList look="tidied" />,
						},
						{
							name: "Option C, next · The edit panel",
							note: "The guess shows only here and on the review screen, labelled “Tally's guess”, drawn as in A.",
							screen: <GuessPanel id="p87-c-panel" source={guessTagLine} />,
						},
						{
							name: "Option C, next · The review screen",
							note: "The same as A's: the guess, labelled “Tally's guess”, with the Why?.",
							screen: (
								<NameQuestion
									id="p87-c-review"
									of="guess"
									source={guessTagLine}
								/>
							),
						},
					]}
				/>
				<Options
					options={[
						{
							name: "With Suggest store names off · The list",
							note: "Tally's guesses are gone: Lupita's and Amazon show their tidied names, and no “Tally's guess” appears. Blue Bottle's name still comes from your bank. The same in A, B and C.",
							screen: <NamesList look="tidied" />,
						},
						{
							name: "With Suggest store names off · The edit panel",
							note: "Blue Bottle's name is still offered, labelled “From your bank” in muted words, as it is with the switch on.",
							screen: bankPanel,
						},
						{
							name: "With Suggest store names off · The review screen",
							note: "Your bank's names are still asked, with “From your bank” under the name. No “Tally's guess” appears, so there is less to go through.",
							screen: (
								<NameQuestion id="p87-off-review" of="bank" source={fromBank} />
							),
						},
					]}
				/>
			</Specimen>
		</>
	);
}

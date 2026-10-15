// P136 (#602): what Bills' Upcoming and Paid this month totals count. The owner picked A (decision 122). Each picture is
// the Bills page from its Due heading down to Paid this month, drawn with the real BillRow, BillStatusHeading and
// PlannedRow on the demo's Thursday, Oct 15. Today's totals are main's (#601): Paid counts its listed rows. Option A
// counts every paid occurrence this month and says which ones aren't listed; option B keeps Paid to its rows and says
// only what Upcoming adds. These drawings stay as the build reference until #602 ships.

import {
	BillRow,
	type BillRowData,
	BillStatusHeading,
} from "../views/bill-row";
import {
	PlannedHeading,
	PlannedRow,
	type PlannedRowData,
} from "../views/planned-expense";
import { Choice, Choices, Desk, Phone, Shot } from "./proposals-polish-4";
import { Specimen } from "./specimen";

const TODAY = "2026-10-15";
const MONTH = "2026-10";

// The demo's categories, as src/demo/seed.ts CATEGORIES names them and src/demo/reset.ts demoBills files each bill:
// Internet, Streaming and Water are Household (5), Daycare is Childcare (6), and Soccer league is Kids (4).
const HOUSEHOLD = { icon: "household", color: "cat-brown" };
const CHILDCARE = { icon: "kids", color: "cat-blue" };
const KIDS = { icon: "kids", color: "cat-ochre" };

// Daycare is a weekly bill on Fridays (dueDay 5, Friday). Bills lists each bill's next occurrence as its row, so
// the Oct 16 Friday is the row; its Oct 23 and 30 Fridays are due later, and its Oct 2 and 9 Fridays are paid.
const INTERNET: BillRowData = {
	id: 4,
	name: "Internet",
	amountCents: 6500,
	status: "due",
	dueDate: "2026-10-18",
	...HOUSEHOLD,
};
const DAYCARE: BillRowData = {
	id: 2,
	name: "Daycare",
	amountCents: 24000,
	status: "due",
	dueDate: "2026-10-16",
	frequency: "weekly",
	dueDay: 5,
	...CHILDCARE,
};
const SOCCER: BillRowData = {
	id: 7,
	name: "Soccer league",
	amountCents: 6833,
	status: "upcoming",
	dueDate: "2027-07-14",
	...KIDS,
};
const STREAMING: BillRowData = {
	id: 8,
	name: "Streaming",
	amountCents: 299,
	status: "paid",
	dueDate: "2026-10-15",
	paidDate: "2026-10-15",
	...HOUSEHOLD,
};
const WATER: BillRowData = {
	id: 9,
	name: "Water",
	amountCents: 1399,
	status: "paid",
	dueDate: "2026-10-15",
	paidDate: "2026-10-15",
	...HOUSEHOLD,
};

// The demo's plans in loadPlans' order (month, then id), as reset.ts sets them: Car registration for September,
// Lawn service for October. Only Lawn service is this month's, so the Planned total is its $90.00.
const PLANS: PlannedRowData[] = [
	{ id: 2, name: "Car registration", amountCents: 18000, month: "2026-09" },
	{ id: 1, name: "Lawn service", amountCents: 9000, month: "2026-10" },
];
const PLANNED_THIS_MONTH_CENTS = 9000;

// The totals as the page adds them: Due is Internet and Daycare's Oct 16 Friday; Upcoming is Daycare's Oct 23 and 30
// Fridays (Soccer league is next July, so it isn't this month); Paid this month is the two rows it lists.
const DAYCARE_FRIDAY = 24000;
const DUE_CENTS = INTERNET.amountCents + DAYCARE.amountCents;
const UPCOMING_CENTS = 2 * DAYCARE_FRIDAY;
const PAID_LISTED_CENTS = STREAMING.amountCents + WATER.amountCents;
const PAID_WITH_FRIDAYS_CENTS = PAID_LISTED_CENTS + 2 * DAYCARE_FRIDAY;

type Totals = {
	paidCents: number;
	/** The muted line under Upcoming's heading, when its total counts Fridays no row lists. */
	upcomingLine?: string;
	/** The muted line under Paid this month's heading, when its total counts paid Fridays no row lists. */
	paidLine?: string;
};

/**
 * One status group as Bills draws it: the real heading with its total, an optional muted line under it, then its
 * rows. A group is a div, not a section, so the drawing holds no section a test would read as a proposal.
 */
function Group({
	status,
	totalCents,
	line,
	bills,
}: {
	status: BillRowData["status"];
	totalCents: number;
	line?: string;
	bills: BillRowData[];
}) {
	return (
		<div class="mt-4">
			<BillStatusHeading status={status} totalCents={totalCents} />
			{line && <p class="text-sm text-muted">{line}</p>}
			<ul class="divide-y divide-rule">
				{bills.map((bill) => (
					<BillRow bill={bill} today={TODAY} href={`/bills/${bill.id}`} />
				))}
			</ul>
		</div>
	);
}

/** The Bills page from its Due heading to Paid this month, in the order Bills draws its groups. */
function Groups({ paidCents, upcomingLine, paidLine }: Totals) {
	return (
		<>
			<Group status="due" totalCents={DUE_CENTS} bills={[INTERNET, DAYCARE]} />
			<Group
				status="upcoming"
				totalCents={UPCOMING_CENTS}
				line={upcomingLine}
				bills={[SOCCER]}
			/>
			<div class="mt-4">
				<PlannedHeading totalCents={PLANNED_THIS_MONTH_CENTS} />
				<ul class="divide-y divide-rule">
					{PLANS.map((plan) => (
						<PlannedRow plan={plan} month={MONTH} today={TODAY} />
					))}
				</ul>
			</div>
			<Group
				status="paid"
				totalCents={paidCents}
				line={paidLine}
				bills={[STREAMING, WATER]}
			/>
		</>
	);
}

/** One option at both sizes: the phone's screen at 390 px, then a desktop window at 1280 px, with Bills current. */
function Pictures({ name, totals }: { name: string; totals: Totals }) {
	return (
		<>
			<Shot caption="At 390 px">
				<Phone label={`${name} at 390 px`} scrolled tab="bills">
					<Groups {...totals} />
				</Phone>
			</Shot>
			<Shot caption="At 1280 px">
				<Desk label={`${name} at 1280 px`} tall={900} active="bills">
					<Groups {...totals} />
				</Desk>
			</Shot>
		</>
	);
}

const TODAY_TOTALS: Totals = { paidCents: PAID_LISTED_CENTS };
const A_TOTALS: Totals = {
	paidCents: PAID_WITH_FRIDAYS_CENTS,
	upcomingLine: "Includes Daycare's Fridays on Oct 23 and 30",
	paidLine: "Includes Daycare's Fridays on Oct 2 and 9",
};
const B_TOTALS: Totals = {
	paidCents: PAID_LISTED_CENTS,
	upcomingLine: "Includes Daycare's Fridays on Oct 23 and 30",
};

/** P136: Upcoming and Paid this month, today and in options A and B, each drawn at 390 and at 1280 px. */
export function BillsTotalsProposal() {
	return (
		<Specimen
			id="p136-bills-totals"
			title="P136 · What Bills' section totals count"
			tier="visual"
			sentence="Bills' Upcoming and Paid this month totals, today and in options A and B, at 390 and 1280 px. Each picture is the Bills page from its Due heading to Paid this month, with the real rows and headings."
		>
			<p class="max-w-prose text-sm">
				<span class="font-medium">In every picture: </span>
				the demo on Thursday, Oct 15. Bills lists one row per bill, so Daycare's
				later Fridays and its paid Fridays aren't rows; only their totals count
				them.
			</p>
			<Choices>
				<Choice
					name="Reference · Today on main"
					note="What main draws now (#601): Upcoming sits above one row, and its total counts Daycare's later Fridays. Paid this month adds the two rows it lists."
					width="w-[824px]"
				>
					<Pictures name="Reference · Today on main" totals={TODAY_TOTALS} />
				</Choice>
				<Choice
					name="Option A · Each heading says what it counts"
					note="Both headings count every occurrence in the month, and say which ones aren't listed."
					extra="The muted line names up to two bills, then “and 2 more”."
					cost="Paid's total adds the month's paid occurrences; one muted line under a heading when its total includes unlisted ones; a decision entry that also fixes spec §8.4's sentence on what totals count."
					why="“Paid this month” means what the family paid, and the two headings count the same way."
					picked
					width="w-[824px]"
				>
					<Pictures
						name="Option A · Each heading says what it counts"
						totals={A_TOTALS}
					/>
				</Choice>
				<Choice
					name="Option B · Paid counts its rows"
					note="Paid is exactly its rows; Upcoming says what else it counts."
					cost="the line under Upcoming only."
					why="a heading's total matches what's under it wherever it can."
					recommended={false}
					width="w-[824px]"
				>
					<Pictures name="Option B · Paid counts its rows" totals={B_TOTALS} />
				</Choice>
			</Choices>
		</Specimen>
	);
}

/** @jsxImportSource hono/jsx */
import type { HtmlEscapedString } from "hono/utils/html";
import { describe, expect, it } from "vitest";
import {
	CATEGORY_SUGGESTION_LABELS,
	categorySuggestionMachine,
} from "../src/machines/category-suggestion";
import {
	MERCHANT_SUGGESTION_LABELS,
	merchantSuggestionMachine,
} from "../src/machines/merchant-suggestion";
import {
	PLAID_LEASE_LABELS,
	plaidLeaseMachine,
} from "../src/machines/plaid-lease";
import {
	READY_CLAIM_LABELS,
	readyClaimMachine,
} from "../src/machines/ready-claim";
import {
	SORTING_TURN_LABELS,
	sortingTurnMachine,
} from "../src/machines/sorting-turn";
import {
	CategoriesDiagram,
	TransactionsDiagram,
} from "../src/views/how-diagrams";
import { MachineDiagram } from "../src/views/machine-diagram";
import { SystemDiagram } from "../src/views/system-diagram";

// A phone's page is 358px wide (390 less a 16px gutter each side). Pele draws a picture at its natural width and the
// page scales it down to fit, so a picture drawn wider than this shows smaller text: its text is 16px, and 400px
// natural scales it to about 14px (issue #904). Keep every picture at or under this width.
const MAX_NATURAL_WIDTH = 400;

const naturalWidth = (html: string) =>
	Number(html.match(/viewBox="0 0 ([\d.]+) [\d.]+"/)?.[1]);

describe("Pele pictures on a phone (issue #904)", () => {
	const pictures: [
		string,
		() => HtmlEscapedString | Promise<HtmlEscapedString>,
	][] = [
		["the system diagram", () => SystemDiagram()],
		[
			"the store-name machine",
			() =>
				MachineDiagram({
					id: "m1",
					title: "t",
					machine: merchantSuggestionMachine,
					labels: MERCHANT_SUGGESTION_LABELS,
				}),
		],
		[
			"the category machine",
			() =>
				MachineDiagram({
					id: "m2",
					title: "t",
					machine: categorySuggestionMachine,
					labels: CATEGORY_SUGGESTION_LABELS,
				}),
		],
		[
			"the ready claim machine",
			() =>
				MachineDiagram({
					id: "m4",
					title: "t",
					machine: readyClaimMachine,
					labels: READY_CLAIM_LABELS,
				}),
		],
		[
			"Transactions",
			() =>
				TransactionsDiagram({
					counted: 321,
					excluded: 12,
					heldForReview: 4,
					needsCategory: 100,
				}),
		],
		[
			"Categories",
			() =>
				CategoriesDiagram({
					user: 100,
					merchantRule: 20,
					bill: 30,
					jev: 190,
					waiting: 100,
					income: 12,
					threshold: "80%",
					ai: "Jev",
				}),
		],
	];

	it.each(pictures)(
		"%s is drawn no wider than a phone page needs",
		(_, draw) => {
			const width = naturalWidth(String(draw()));
			expect(width).toBeGreaterThan(0);
			expect(width).toBeLessThanOrEqual(MAX_NATURAL_WIDTH);
		},
	);

	// A state that time reaches, not an event (the lease's "Ran out", the sorting turn's own), has no arrow into it, so
	// Pele draws it on the top rank beside the first state and the picture comes out wider: the lease at 422px, the
	// sorting turn at 404px. The page still scales them to fit a phone (about 13px text), so they keep a looser bound
	// here instead of being left out, and a new picture cannot grow past it unnoticed.
	const MAX_NATURAL_WIDTH_WITH_TIME_STATE = 430;

	it.each([
		["the plaid lease machine", plaidLeaseMachine, PLAID_LEASE_LABELS],
		["the sorting turn machine", sortingTurnMachine, SORTING_TURN_LABELS],
	] as const)(
		"%s, with a state time reaches, stays under the looser bound",
		(_, machine, labels) => {
			const width = naturalWidth(
				String(MachineDiagram({ id: "m5", title: "t", machine, labels })),
			);

			expect(width).toBeGreaterThan(MAX_NATURAL_WIDTH);
			expect(width).toBeLessThanOrEqual(MAX_NATURAL_WIDTH_WITH_TIME_STATE);
		},
	);
});

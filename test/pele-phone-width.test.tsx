/** @jsxImportSource hono/jsx */
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
	BillsDiagram,
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
	const pictures: [string, () => unknown][] = [
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
			"Bills",
			() =>
				BillsDiagram({
					amount: "$1,234.56",
					due: "Sep 21",
					paid: "Sep 24",
					windowDays: 5,
					tolerance: "10%",
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
});

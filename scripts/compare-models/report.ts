// Renders the comparison as markdown for the owner: a summary table per list, then each case, then what each
// model sent back when a call failed. Plain words throughout (CLAUDE.md, the owner reads it).
import { JEV_THRESHOLD } from "../../src/ai/categorize";
import { BASIS_POINTS } from "../../src/ai/confidence";
import {
	type Case,
	median,
	type PayeeAnswer,
	type Row,
	type Summary,
	summarize,
} from "./score";

export type ReportList = {
	id: "demo" | "fifty";
	title: string;
	categories: string[];
	models: { name: string; rows: Row[] }[];
};

/** What a model sent back that the owner needs to see: once per model, however many calls failed. */
export type ModelNote = {
	name: string;
	error?: string;
	unreadable?: string;
	usage?: unknown;
};

export type ReportInput = {
	today: string;
	cases: Case[];
	/** "ran", "skipped, no JEV_API_KEY", or "not in this run". */
	jevStatus: string;
	lists: ReportList[];
	notes: ModelNote[];
};

/** A confidence as Tally compares it: floored to hundredths of a percent, so 0.7999 reads 79.99%. */
const pct = (confidence: number) =>
	`${(Math.floor(confidence * BASIS_POINTS) / 100).toFixed(2)}%`;

/** Keeps a bank's text from breaking a table row. */
const cell = (text: string) => text.replace(/\|/g, "\\|");

function answerCell(row: Row | undefined): string {
	if (!row) return "—";

	if (!row.answer) return cell(row.outcome);
	const a = row.answer;

	const set = Object.entries(a.flags)
		.filter(([, outcome]) => outcome === "hit" || outcome === "false alarm")
		.map(([flag]) => flag);

	const check = a.applied ? " ✓" : "";
	const flags = set.length > 0 ? `, flags: ${set.join(", ")}` : "";

	return cell(`${a.pick} ${pct(a.confidence)}${check}${flags}`);
}

function summaryRow(name: string, s: Summary): string {
	const confidence = s.confidence
		? `${pct(s.confidence.low)} / ${pct(s.confidence.middle)} / ${pct(s.confidence.high)}`
		: "—";

	const time = s.ms ? `${Math.round(s.ms.middle)} / ${s.ms.slowest}` : "—";

	return `| ${name} | ${s.worked} of ${s.total} | ${s.right} | ${s.rightPickAnyConfidence} | ${s.wrong} | ${s.leftNoneFit} / ${s.leftUnsure} | ${s.appliedNoRight} | ${s.flags.hit} / ${s.flags.falseAlarm} / ${s.flags.missed} | ${s.mixedAndNote} | ${confidence} | ${time} |`;
}

function listSection(list: ReportList, cases: Case[]): string[] {
	const lines = [
		`## ${list.title}`,
		"",
		"| Model | Calls that worked | Right | Right pick at any confidence | Wrong | Left (none fit / unsure) | Applied with no right answer | Flags (hit / false alarm / missed) | Mixed and note answered | Confidence (low / middle / high) | Time in ms (middle / slowest) |",
		"|---|---|---|---|---|---|---|---|---|---|---|",
		...list.models.map((m) => summaryRow(m.name, summarize(m.rows))),
		"",
	];

	if (list.id === "fifty") {
		lines.push(
			"Some of the 50 names fit these stores as well as the demo's own category does, so read the picks, not just the count.",
			"",
		);
	}

	lines.push(
		"| Raw name | Direction | The demo's category | " +
			list.models.map((m) => m.name).join(" | ") +
			" |",
		`|---|---|---|${list.models.map(() => "---").join("|")}|`,
	);
	cases.forEach((kase, i) => {
		lines.push(
			`| ${cell(kase.rawName)} | ${kase.direction} | ${cell(kase.rightCategory ?? "a person decides")} | ${list.models.map((m) => answerCell(m.rows[i])).join(" | ")} |`,
		);
	});
	lines.push("");

	return lines;
}

function notesSection(notes: ModelNote[]): string[] {
	const shown = notes.filter(
		(note) =>
			note.error !== undefined ||
			note.unreadable !== undefined ||
			note.usage !== undefined,
	);

	if (shown.length === 0) return [];
	const lines = ["## What each model sent back", ""];

	for (const note of shown) {
		lines.push(`### ${note.name}`, "");

		if (note.error !== undefined) lines.push(`First error: ${note.error}`, "");

		if (note.unreadable !== undefined)
			lines.push(
				"First unreadable body:",
				"",
				"```",
				note.unreadable,
				"```",
				"",
			);

		if (note.usage !== undefined)
			lines.push(
				"First usage:",
				"",
				"```json",
				JSON.stringify(note.usage, null, 2),
				"```",
				"",
			);
	}

	return lines;
}

export function formatReport(input: ReportInput): string {
	const lines = [
		"# Clef and Jev on the demo seed",
		"",
		`Date: ${input.today}. Cases: ${input.cases.length}, one per raw name and direction.`,
		`Jev: ${input.jevStatus}.`,
		"",
		"The demo's rows carry no Plaid category, which real rows do.",
		"Times are measured from this machine through wrangler dev.",
		"",
	];

	for (const list of input.lists) {
		lines.push(...listSection(list, input.cases));
	}

	lines.push(...notesSection(input.notes));

	return `${lines.join("\n")}\n`;
}

// ---- The store lookup line (#984) ----------------------------------------

/** One case's three asks: plain, plain again (the noise floor), and with its hand-written line. */
export type LookupEntry = {
	kase: Case;
	line: string;
	plain: Row;
	again: Row;
	lined: Row;
};

export type LookupCounts = {
	cases: number;
	/** Cases with a right answer: the ones the right and wrong counts are over. */
	scored: number;
	/** Cases whose two plain runs gave a different category. */
	planDiffers: number;
	/** The largest confidence gap between the two plain runs, or null when none was answered. */
	largestGap: number | null;
	rightBefore: number;
	rightAfter: number;
	movedToRight: number;
	movedFromRight: number;
	/** Cases whose category changed with the line, either way. */
	changed: number;
	medianBefore: number | null;
	medianAfter: number | null;
	/** Cases Tally would file, before and after the line. */
	filedBefore: number;
	filedAfter: number;
};

/** The counts over the lookup entries. A case with no right answer is in the totals only, not in the right counts. */
export function lookupCounts(entries: LookupEntry[]): LookupCounts {
	const scored = entries.filter((e) => e.kase.rightCategory !== null);

	const plainPairs = entries.flatMap(({ plain, again }) =>
		plain.answer && again.answer ? [[plain.answer, again.answer] as const] : [],
	);

	const linedPairs = entries.flatMap(({ plain, lined }) =>
		plain.answer && lined.answer ? [[plain.answer, lined.answer] as const] : [],
	);

	const gaps = plainPairs.map(([a, b]) =>
		Math.abs(a.confidence - b.confidence),
	);

	const before = entries.flatMap((e) =>
		e.plain.answer ? [e.plain.answer.confidence] : [],
	);

	const after = entries.flatMap((e) =>
		e.lined.answer ? [e.lined.answer.confidence] : [],
	);

	return {
		cases: entries.length,
		scored: scored.length,
		planDiffers: plainPairs.filter(([a, b]) => a.pick !== b.pick).length,
		largestGap: gaps.length > 0 ? Math.max(...gaps) : null,
		rightBefore: scored.filter((e) => e.plain.outcome === "right").length,
		rightAfter: scored.filter((e) => e.lined.outcome === "right").length,
		movedToRight: scored.filter(
			(e) => e.plain.outcome !== "right" && e.lined.outcome === "right",
		).length,
		movedFromRight: scored.filter(
			(e) => e.plain.outcome === "right" && e.lined.outcome !== "right",
		).length,
		changed: linedPairs.filter(([a, b]) => a.pick !== b.pick).length,
		medianBefore: before.length > 0 ? median(before) : null,
		medianAfter: after.length > 0 ? median(after) : null,
		filedBefore: entries.filter((e) => e.plain.answer?.applied).length,
		filedAfter: entries.filter((e) => e.lined.answer?.applied).length,
	};
}

export type LookupReportInput = {
	/** "ran", "skipped, no JEV_API_KEY" or "not in this run". */
	jevStatus: string;
	entries: LookupEntry[];
	/** The seed's cases with no line: never searched, so never asked. */
	noLine: Case[];
	notes: ModelNote[];
};

/** A row's answer as the table shows it: Jev's pick and confidence, a check when Tally would file it, or the outcome. */
function lookupCell(row: Row): string {
	if (!row.answer) return cell(row.outcome);

	const check = row.answer.applied ? " ✓" : "";

	return cell(`${row.answer.pick} ${pct(row.answer.confidence)}${check}`);
}

export function formatLookupReport(input: LookupReportInput): string {
	const c = lookupCounts(input.entries);

	const noise =
		c.largestGap === null
			? "Noise floor: no two plain runs both gave an answer, so there is nothing to compare."
			: `Noise floor: the two plain runs gave a different category for ${c.planDiffers} of ${c.cases} cases, and the largest confidence gap between them was ${pct(c.largestGap)}. Read every move below against this.`;

	const lines = [
		"# Does a store line help Jev?",
		"",
		'These lines are hand-written, and some name a category outright ("groceries and household goods"), as a real lookup line might. Nothing here searches the web, so this is the best case a real lookup can reach, not a forecast.',
		"",
		"Each case is asked once per condition, so small moves are within the noise floor shown.",
		"",
		`Jev: ${input.jevStatus}. Cases with a line: ${c.cases}. Cases with no line: ${input.noLine.length}.`,
		"",
		"## Summary",
		"",
		noise,
		"",
		"Unsure means Jev left the case: unsure, or none of the categories fit.",
		"",
		"| Count | Value |",
		"|---|---|",
		`| Cases with a right answer | ${c.scored} |`,
		`| Right before | ${c.rightBefore} |`,
		`| Right after | ${c.rightAfter} |`,
		`| Moved from wrong or unsure to right | ${c.movedToRight} |`,
		`| Moved from right to wrong or unsure | ${c.movedFromRight} |`,
		`| Category changed either way | ${c.changed} |`,
		`| Median category confidence, before / after | ${c.medianBefore === null ? "—" : pct(c.medianBefore)} / ${c.medianAfter === null ? "—" : pct(c.medianAfter)} |`,
		`| Filed (at or above the threshold), before / after | ${c.filedBefore} / ${c.filedAfter} |`,
		"",
		"## Cases",
		"",
		"| Raw name | The line | The demo's category | Before | Before, again (noise) | After, with the line |",
		"|---|---|---|---|---|---|",
		...input.entries.map(
			(e) =>
				`| ${cell(e.kase.rawName)} | ${cell(e.line)} | ${cell(e.kase.rightCategory ?? "a person decides")} | ${lookupCell(e.plain)} | ${lookupCell(e.again)} | ${lookupCell(e.lined)} |`,
		),
		"",
		"## No line",
		"",
		"These cases have no line, so they are never searched and Jev was not asked about them:",
		"",
		...input.noLine.map(
			(kase) => `- ${cell(kase.rawName)} (${kase.direction})`,
		),
		"",
	];

	lines.push(...notesSection(input.notes));

	return `${lines.join("\n")}\n`;
}

// ---- The payee question (#984, part two) ---------------------------------

export type PayeeRow = {
	rawName: string;
	/** Who the hand-written row or the bank text is: a person, or a business. */
	expected: "person" | "business";
	answer: PayeeAnswer;
	/** "answered", "no answer", or the skipped outcome when there was no key. */
	outcome: string;
};

/** Tally would let a lookup run only for a business Jev is at least the threshold sure of (spec §7). */
export const wouldBeSearched = (row: PayeeRow): boolean =>
	row.answer !== null &&
	row.answer.choice === "business" &&
	row.answer.confidence >= JEV_THRESHOLD;

export type PayeeCounts = {
	peopleLetThrough: number;
	peopleHeldBack: number;
	businessesLetThrough: number;
	businessesHeldBack: number;
};

export function payeeCounts(rows: PayeeRow[]): PayeeCounts {
	const count = (expected: PayeeRow["expected"], searched: boolean) =>
		rows.filter(
			(r) => r.expected === expected && wouldBeSearched(r) === searched,
		).length;

	return {
		peopleLetThrough: count("person", true),
		peopleHeldBack: count("person", false),
		businessesLetThrough: count("business", true),
		businessesHeldBack: count("business", false),
	};
}

export type PayeeReportInput = {
	jevStatus: string;
	rows: PayeeRow[];
	notes: ModelNote[];
};

export function formatPayeeReport(input: PayeeReportInput): string {
	const c = payeeCounts(input.rows);

	const lines = [
		"# Can Jev tell a person from a business?",
		"",
		"These names are hand-written, not from the bank, so this is a best case for the question.",
		"",
		`Jev: ${input.jevStatus}. Rows: ${input.rows.length}.`,
		"",
		"## Summary",
		"",
		`- People Jev would let be searched (the one that matters): ${c.peopleLetThrough}`,
		`- People held back: ${c.peopleHeldBack}`,
		`- Businesses let through: ${c.businessesLetThrough}`,
		`- Businesses held back: ${c.businessesHeldBack}`,
		"",
		"A business is let through only at the threshold or more. Anything else is held back, including no answer.",
		"",
		"## Rows",
		"",
		"| Raw name | Expected | Jev's answer | Confidence | Would be searched |",
		"|---|---|---|---|---|",
		...input.rows.map((r) => {
			const answer = r.answer ? cell(r.answer.choice) : cell(r.outcome);
			const confidence = r.answer ? pct(r.answer.confidence) : "—";

			return `| ${cell(r.rawName)} | ${r.expected} | ${answer} | ${confidence} | ${wouldBeSearched(r) ? "yes" : "no"} |`;
		}),
		"",
	];

	lines.push(...notesSection(input.notes));

	return `${lines.join("\n")}\n`;
}

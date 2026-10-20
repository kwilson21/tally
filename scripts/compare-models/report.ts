// Renders the comparison as markdown for the owner: a summary table per list, then each case, then what each
// model sent back when a call failed. Plain words throughout (CLAUDE.md, the owner reads it).
import { BASIS_POINTS } from "../../src/ai/confidence";
import type { Case, Row, Summary } from "./score";
import { summarize } from "./score";

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

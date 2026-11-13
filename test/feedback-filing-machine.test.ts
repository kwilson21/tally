import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { transition } from "xstate";
import {
	FILING_ATTEMPT_CAP,
	type FilingState,
	feedbackFiling,
	filingStateOf,
	giveUpReason,
	readySql,
	type StoredFiling,
} from "../src/machines/feedback-filing";
import { next } from "../src/machines/next";

// The feedback filing machine (issue #863, first half): one row's GitHub filing, in four states. The tests walk the
// machine's own moves; test/feedback.test.ts pins the stored columns each writer leaves behind.

const CAP = FILING_ATTEMPT_CAP;
const EVENTS = [
	"CLAIM",
	"FILED",
	"REJECTED",
	"TOKEN_REFUSED",
	"FAILED",
	"LEASE_EXPIRED",
];

/** The state and count the machine reaches from a state and a count, after one event. */
function moveOf(state: string, attempts: number, event: string) {
	const from = feedbackFiling.resolveState({
		value: state,
		context: { attempts },
	});
	const [after] = transition(feedbackFiling, from, { type: event });

	return { state: String(after.value), attempts: after.context.attempts };
}

describe("the feedback filing machine", () => {
	it("starts unfiled", () => {
		expect(feedbackFiling.config.initial).toBe("unfiled");
	});

	it("CLAIM takes an unfiled row to claimed and counts the try", () => {
		expect(moveOf("unfiled", 0, "CLAIM")).toEqual({
			state: "claimed",
			attempts: 1,
		});
		expect(moveOf("unfiled", CAP - 1, "CLAIM")).toEqual({
			state: "claimed",
			attempts: CAP,
		});
	});

	it("FILED files a claimed row and keeps its count", () => {
		expect(moveOf("claimed", 2, "FILED")).toEqual({
			state: "filed",
			attempts: 2,
		});
	});

	it("REJECTED gives up at once, with the count at the cap", () => {
		expect(moveOf("claimed", 1, "REJECTED")).toEqual({
			state: "gave_up",
			attempts: CAP,
		});
		expect(moveOf("claimed", CAP, "REJECTED")).toEqual({
			state: "gave_up",
			attempts: CAP,
		});
	});

	it("TOKEN_REFUSED releases the claim and gives the try back", () => {
		expect(moveOf("claimed", 1, "TOKEN_REFUSED")).toEqual({
			state: "unfiled",
			attempts: 0,
		});
		expect(moveOf("claimed", CAP, "TOKEN_REFUSED")).toEqual({
			state: "unfiled",
			attempts: CAP - 1,
		});
	});

	it("FAILED releases the claim and keeps the try counted, below the cap", () => {
		expect(moveOf("claimed", 1, "FAILED")).toEqual({
			state: "unfiled",
			attempts: 1,
		});
		expect(moveOf("claimed", CAP - 1, "FAILED")).toEqual({
			state: "unfiled",
			attempts: CAP - 1,
		});
	});

	it("FAILED on the cap's try gives up as exhausted", () => {
		expect(moveOf("claimed", CAP, "FAILED")).toEqual({
			state: "gave_up",
			attempts: CAP,
		});
	});

	it("LEASE_EXPIRED: a cut-off try below the cap is ready again, and the cap's try gives up", () => {
		expect(moveOf("claimed", 4, "LEASE_EXPIRED")).toEqual({
			state: "unfiled",
			attempts: 4,
		});
		expect(moveOf("claimed", CAP, "LEASE_EXPIRED")).toEqual({
			state: "gave_up",
			attempts: CAP,
		});
	});

	it("a claimed row refuses another CLAIM", () => {
		expect(
			next(feedbackFiling, "claimed", "CLAIM", { attempts: 1 }),
		).toBeNull();
	});

	it("an unfiled row refuses every event but CLAIM", () => {
		for (const event of EVENTS.filter((e) => e !== "CLAIM")) {
			expect(
				next(feedbackFiling, "unfiled", event, { attempts: 1 }),
			).toBeNull();
		}
	});

	it("filed refuses every event", () => {
		for (const event of EVENTS) {
			expect(next(feedbackFiling, "filed", event, { attempts: 1 })).toBeNull();
		}
	});

	it("gave_up refuses every event", () => {
		for (const event of EVENTS) {
			expect(
				next(feedbackFiling, "gave_up", event, { attempts: CAP }),
			).toBeNull();
		}
	});
});

describe("filingStateOf and giveUpReason", () => {
	// A fixed clock: the helper takes the time as an input, so these rows are read at one instant.
	const NOW = Date.parse("2026-11-13T12:00:00Z");
	const row = (over: Partial<StoredFiling>): StoredFiling => ({
		attempts: 0,
		githubIssueNumber: null,
		filingAt: null,
		lastStatus: null,
		...over,
	});

	const cases: [string, StoredFiling, FilingState][] = [
		["a fresh row is unfiled", row({}), "unfiled"],
		[
			"a claim exactly 10 minutes old has expired, so the row is unfiled",
			row({ attempts: 4, filingAt: "2026-11-13 11:50:00" }),
			"unfiled",
		],
		[
			"a claim 1 second under 10 minutes old is live",
			row({ attempts: 4, filingAt: "2026-11-13 11:50:01" }),
			"claimed",
		],
		[
			"a live claim on the cap's try is still claimed",
			row({ attempts: CAP, filingAt: "2026-11-13 11:55:00" }),
			"claimed",
		],
		[
			"a cut-off try on the cap gives up as exhausted",
			row({ attempts: CAP, filingAt: "2026-11-13 11:49:59" }),
			"gave_up",
		],
		[
			"a row at the cap with no claim gives up as exhausted",
			row({ attempts: CAP }),
			"gave_up",
		],
		[
			"a filed row is filed, whatever its count",
			row({
				attempts: 1,
				githubIssueNumber: 7,
				filingAt: "2026-11-13 11:59:00",
			}),
			"filed",
		],
		[
			"a 422 row gives up as rejected",
			row({ attempts: CAP, lastStatus: 422 }),
			"gave_up",
		],
		[
			"a 401 from before a refund does not make a row rejected",
			row({ attempts: CAP, lastStatus: 401 }),
			"gave_up",
		],
	];

	for (const [label, stored, state] of cases) {
		it(label, () => {
			expect(filingStateOf(stored, NOW)).toBe(state);
		});
	}

	it("names a give-up as rejected only for a 422, and as exhausted otherwise", () => {
		expect(giveUpReason(422)).toBe("rejected");
		expect(giveUpReason(429)).toBe("exhausted");
		expect(giveUpReason(401)).toBe("exhausted");
		expect(giveUpReason(null)).toBe("exhausted");
	});
});

describe("readySql selects exactly the rows the machine calls unfiled", () => {
	// Each seed: a count, a claim stamp (a SQLite expression, or NULL), a filed issue number, and a last status.
	const seeds: {
		label: string;
		attempts: number;
		filingAt: string | null;
		issue: number | null;
		lastStatus: number | null;
	}[] = [
		{
			label: "fresh",
			attempts: 0,
			filingAt: null,
			issue: null,
			lastStatus: null,
		},
		{
			label: "fourth try, no claim",
			attempts: 4,
			filingAt: null,
			issue: null,
			lastStatus: null,
		},
		{
			label: "claim 10 minutes old, below the cap",
			attempts: 4,
			filingAt: "datetime('now', '-10 minutes')",
			issue: null,
			lastStatus: 500,
		},
		{
			label: "claim 11 minutes old, below the cap",
			attempts: 1,
			filingAt: "datetime('now', '-11 minutes')",
			issue: null,
			lastStatus: null,
		},
		{
			label: "claim 9 minutes old",
			attempts: 1,
			filingAt: "datetime('now', '-9 minutes')",
			issue: null,
			lastStatus: null,
		},
		{
			label: "claim 10 minutes old, on the cap",
			attempts: CAP,
			filingAt: "datetime('now', '-10 minutes')",
			issue: null,
			lastStatus: null,
		},
		{
			label: "at the cap, no claim",
			attempts: CAP,
			filingAt: null,
			issue: null,
			lastStatus: 422,
		},
		{ label: "filed", attempts: 1, filingAt: null, issue: 12, lastStatus: 201 },
	];

	it("matches filingStateOf row by row, over every state and both sides of the 10-minute boundary", async () => {
		await env.DB.prepare("DELETE FROM feedback").run();

		for (const seed of seeds) {
			await env.DB.prepare(
				`INSERT INTO feedback (actor, type, feeling, message, page, device, attempts, filing_at, github_issue_number, last_status)
				 VALUES ('person', 'Bug', 'Okay', ?, '/', 'Desktop Chrome', ?, ${seed.filingAt ?? "NULL"}, ?, ?)`,
			)
				.bind(seed.label, seed.attempts, seed.issue, seed.lastStatus)
				.run();
		}

		const stored = await env.DB.prepare(
			"SELECT id, message, attempts, github_issue_number AS githubIssueNumber, filing_at AS filingAt, last_status AS lastStatus FROM feedback",
		).all<StoredFiling & { id: number; message: string }>();

		const now = Date.now();
		const byMachine = stored.results
			.filter((row) => filingStateOf(row, now) === "unfiled")
			.map((row) => row.id)
			.sort((a, b) => a - b);

		const bySql = (
			await env.DB.prepare(`SELECT id FROM feedback WHERE ${readySql()}`).all<{
				id: number;
			}>()
		).results
			.map((row) => row.id)
			.sort((a, b) => a - b);

		const states = new Set(
			stored.results.map((row) => filingStateOf(row, now)),
		);

		expect(bySql).toEqual(byMachine);
		expect(bySql.length).toBeGreaterThan(0);
		expect(states).toEqual(new Set(["unfiled", "claimed", "filed", "gave_up"]));
	});
});

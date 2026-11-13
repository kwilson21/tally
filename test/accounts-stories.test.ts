import { describe, expect, it } from "vitest";
import {
	checkIn,
	linkBank,
	removeAppleCard,
	syncNow,
	uploadAppleCard,
} from "../src/rules/accounts";
import { answerOf, nothingToDo, refuse, write } from "./helpers/rule-answers";

// The accounts area's style 3 rules as stories (decisions 187, 206, 210). The two requests that wait for Plaid are in
// test/bank-request-stories.test.ts. The time and the person are inputs (decision 195).

const NOW = 1_800_000_000_000;

describe("Link a bank", () => {
	const request = {
		institution: "Chase",
		plaidItemId: "item-1",
		who: "me",
		today: "2026-11-13",
	};

	it.each([
		["says Tally is reading its history while setup is still to do", true],
		["says only that it is linked once setup is done", false],
	])("%s", (_story, settingUp) => {
		expect(answerOf(linkBank.decide(request, { settingUp }))).toEqual(
			write({ ...request, announceReading: settingUp }),
		);
	});
});

describe("Sync every bank now", () => {
	it("always runs: it refuses nothing, and with no working bank it still applies the merchant rules", () => {
		expect(answerOf(syncNow.decide({}, null))).toEqual(write({ sync: true }));
	});
});

describe("Upload an Apple Card statement", () => {
	const upload = uploadAppleCard<{ id: string }>();
	const ROWS = [{ id: "a" }, { id: "b" }];
	const REFUSED = refuse("UploadRefused", "Check the file and the balance.");

	const ask = (
		file: { rows: { id: string }[] } | { error: string },
		balance: { cents: number | null } | { error: string },
	) =>
		answerOf(
			upload.decide({ file, balance, who: "me", today: "2026-11-13" }, null),
		);

	it("stores the rows with the balance", () => {
		expect(ask({ rows: ROWS }, { cents: 124_018 })).toEqual(
			write({
				rows: ROWS,
				balanceCents: 124_018,
				who: "me",
				today: "2026-11-13",
			}),
		);
	});

	it("stores the rows and leaves the balance when it was left blank", () => {
		expect(ask({ rows: ROWS }, { cents: null })).toEqual(
			write({ rows: ROWS, balanceCents: null, who: "me", today: "2026-11-13" }),
		);
	});

	it.each([
		["a file that is not Apple's CSV", { error: "bad file" }, { cents: 1 }],
		["a balance that is not an amount", { rows: ROWS }, { error: "bad" }],
		["both", { error: "bad file" }, { error: "bad" }],
	])("refuses %s", (_story, file, balance) => {
		expect(ask(file, balance)).toEqual(REFUSED);
	});
});

describe("Remove Apple Card", () => {
	const ask = (card: { removed: boolean } | null, deleteHistory = false) =>
		answerOf(removeAppleCard.decide({ deleteHistory }, { card }));

	it.each([
		[
			"removes the card and keeps its history",
			{ removed: false },
			false,
			write({ deleteHistory: false }),
		],
		[
			"removes the card with its history",
			{ removed: false },
			true,
			write({ deleteHistory: true }),
		],
		[
			"has nothing to do for a card already removed",
			{ removed: true },
			true,
			nothingToDo(),
		],
		["has nothing to do when there is no card", null, false, nothingToDo()],
	])("%s", (_story, card, deleteHistory, answer) => {
		expect(ask(card, deleteHistory)).toEqual(answer);
	});
});

describe("Say a person is still on the setup page", () => {
	const ask = (member: boolean, lastSeenMs: number | null) =>
		answerOf(
			checkIn.decide({ member: "me", now: NOW }, { member, lastSeenMs }),
		);

	const WRITES = write({ member: "me", now: NOW });

	it.each([
		["writes a first check-in", true, null, WRITES],
		["writes once the last one is 30 seconds old", true, NOW - 30_000, WRITES],
		["has nothing to do inside 30 seconds", true, NOW - 29_999, nothingToDo()],
		[
			"has nothing to do for a person who was removed",
			false,
			null,
			nothingToDo(),
		],
	])("%s", (_story, member, lastSeenMs, answer) => {
		expect(ask(member, lastSeenMs)).toEqual(answer);
	});
});

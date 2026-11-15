// What each stored JSON case answers, as one string: the site's reader run on the case, JSON-encoded so a -0 or a
// non-finite number is kept apart from 0 and a string. A reader that throws answers its error's class and nothing else,
// since a message can hold stored data. Shared by the characterise test and the baseline recorder (#1120).

import { parseUnpaidBills } from "../src/bills/unpaid";
import type { Guard } from "../src/db/stored-shape";
import {
	hasStoredFields,
	isArrayOf,
	isBoolean,
	isNumber,
	isRecordOf,
	isString,
	readStored,
} from "../src/db/stored-shape";
import { readFeedbackForm } from "../src/feedback/form";
import { shownBudgetIds } from "../src/first-tally/budgets";
import { keptTryFrom } from "../src/first-tally/ready-email";
import type { Json } from "../src/json";
import { diagnosticLinesOf } from "../src/routes/feedback";
import { parseSuggestedNames } from "../src/transactions/name-suggestions";
import {
	type GuardName,
	KEPT_HASH,
	type StoredCase,
} from "./stored-json-corpus";

const GUARD_READS: Record<GuardName, Guard<Json>> = {
	number: isNumber,
	strings: isArrayOf(isString),
	pair: hasStoredFields<{ a: number; b: string }>({ a: isNumber, b: isString }),
	flags: isRecordOf(isBoolean),
};

/** True for a number value. */
const isNumberValue = (value: Json): value is number =>
	typeof value === "number";

/** Numbers JSON cannot tell apart from 0 or from a string are written as a tagged string. */
const replacer = (_key: string, value: Json) =>
	isNumberValue(value) && (Object.is(value, -0) || !Number.isFinite(value))
		? { "#number": Object.is(value, -0) ? "-0" : String(value) }
		: value;

function formFor(clientContext: string | null): FormData {
	const form = new FormData();

	form.set("from", "/first-tally");
	form.set("include_diagnostics", "yes");

	if (clientContext !== null) form.set("client_context", clientContext);

	return form;
}

function run(c: StoredCase): Json | undefined {
	switch (c.site) {
		case "unpaid":
			return parseUnpaidBills(c.stored);
		case "names":
			return parseSuggestedNames(c.stored);
		case "kept":
			return keptTryFrom(c.held, KEPT_HASH);
		case "diagnostics":
			return diagnosticLinesOf(c.clientContext, c.page);
		case "context":
			return readFeedbackForm(formFor(c.clientContext)).clientContext;
		case "budgets":
			return shownBudgetIds(c.values);
		case "stored":
			return readStored(c.text, GUARD_READS[c.guard]);
	}
}

/** A value as the text the baseline holds it: JSON, with -0 and non-finite numbers kept apart. */
export function encodeAnswer(value: Json | undefined): string {
	return JSON.stringify(value, replacer) ?? "undefined";
}

/** The answer for one case, as the text the baseline holds. */
export function answerOf(c: StoredCase): string {
	try {
		return encodeAnswer(run(c));
	} catch (error) {
		return `throws ${error instanceof Error ? error.name : "non-error"}`;
	}
}

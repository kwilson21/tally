// How the settings rules (src/rules/settings.ts) read their facts and save what they decide (decisions 190 and 206).
// The rule decides in TypeScript; the database only checks that what the rule read has not changed since, and raises
// an error when it has, so a setting is never saved on rows that changed a moment earlier.
import { eq, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle } from "drizzle-orm/d1";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
	type AiSwitchesFacts,
	type AiSwitchesWrite,
	type AlwaysRuleFacts,
	type ChangeLineFacts,
	type ChangeLineWrite,
	type ForgetWrite,
	type NeverSuggestLineFacts,
	type PersonFacts,
	PersonNameTaken,
	type RemoveAddressWrite,
	type RemoveAlwaysRuleWrite,
	type RemoveNeverSuggestWrite,
	type RemovePersonWrite,
	type RenamePersonWrite,
	removeNeverSuggestLine,
	type UndoForgetFacts,
	type UndoForgetWrite,
} from "../rules/settings";
import { undoLeftMs } from "../undo";
import {
	AI_SWITCHES_VERSION,
	aiSwitchStatements,
	readAiSwitches,
} from "./ai-switches";
import { changeBankTextRuleStatements } from "./bank-text-rules";
import { Database, runWith } from "./database";
import { waitsForRunStatement } from "./first-tally";
import { decideAndSave, guardedSave } from "./guarded-save";
import { CLEAR_MERCHANT_RULE_SQL } from "./merchant-rules";
import {
	type NeverSuggestRule,
	neverSuggestLine,
	removeNeverSuggestStatement,
} from "./never-suggest";
import { leftEmpty } from "./refused";
import {
	householdMembers,
	householdPeople,
	householdSettings,
	pushSubscriptions,
	transactions,
} from "./schema";
import { waitingForJevSql } from "./transactions";

/**
 * The guard, the first statement of every save that read something: it adds nothing while the rows are still as the
 * rule read them, and tries to add a setting with no value when they are not. The value is NOT NULL, so that fails
 * the statement and the whole batch with an error settingsChangedSinceRead knows (SQLite's RAISE works only inside a
 * trigger). `version` is the rule's version SQL; its own values are bound first, then the version the rule read.
 * A list still written as SQL uses this one; a list written with Drizzle uses guardOrm, the same statement.
 */
const rawGuard = (
	db: D1Database,
	version: string,
	expectedVersion: string,
	...binds: (string | number)[]
) =>
	db
		.prepare(
			`INSERT INTO household_settings (key, value) SELECT 'settings_guard', NULL WHERE ${version} IS NOT ?${binds.length + 1}`,
		)
		.bind(...binds, expectedVersion);

/**
 * The same guard as guardOrm's builder: `version` is the rule's version as Drizzle SQL with its values bound, and the
 * version the rule read is bound last, as the raw guard binds it.
 */
const guardOrm = (db: D1Database, version: SQL, expectedVersion: string) =>
	drizzle(db)
		.insert(householdSettings)
		.select(
			drizzle(db)
				.select({
					key: sql`'settings_guard'`.as("key"),
					value: sql`NULL`.as("value"),
				})
				.from(sql`(SELECT 1)`)
				.where(sql`${version} IS NOT ${expectedVersion}`),
		);

/** Whether a save failed because what the rule read had changed, and not for any other reason. Only a guard can try to store a NULL setting. */
export const settingsChangedSinceRead = leftEmpty(
	"household_settings",
	"value",
);

/** A Drizzle batch: one or more builder statements, run with drizzle(db).batch, which needs at least one. */
type DrizzleItems = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

/**
 * What a save runs in one batch: the raw D1 statements of a list still written as SQL (they move with their batch), or
 * a Drizzle batch (`drizzle` is the batch's statements). Both are atomic; the two kinds are told apart by this wrapper.
 */
export type SettingBatch = D1PreparedStatement[] | { drizzle: DrizzleItems };

/** One Drizzle batch of the statements given, in order. */
const inOneBatch = (...items: DrizzleItems) => ({ drizzle: items });

const runBatch = (db: D1Database, batch: SettingBatch) =>
	Array.isArray(batch) ? db.batch(batch) : drizzle(db).batch(batch.drizzle);

/**
 * Reads a settings rule's facts, asks the rule and saves what it decides in one batch, asking again on fresh facts
 * when the guard raises (decideAndSave). `statements` may read what the save needs first, so it is asked for a promise.
 * Answers with the facts it decided on and what the rule decided (nothing, when what was asked is already true).
 */
export const decideSetting = <Request, F, W, E, Taken = never>(
	settingRule: {
		decide: (request: Request, facts: F) => Effect.Effect<Option.Option<W>, E>;
	},
	request: Request,
	facts: (db: D1Database) => Promise<F>,
	statements: (db: D1Database, save: W) => SettingBatch | Promise<SettingBatch>,
	whenNameTaken?: () => Taken,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* decideAndSave({
			facts: Effect.promise(() => facts(db)),
			decide: (read) => settingRule.decide(request, read),
			save: (write) =>
				guardedSave(
					async () => runBatch(db, await statements(db, write)),
					settingsChangedSinceRead,
					whenNameTaken,
				),
			gaveUp: "A setting kept changing while it was being saved.",
		});
	});

/** For a rule that reads nothing stored. */
export const noFacts = async () => null;

// The AI switches.

export async function aiSwitchesFacts(
	db: D1Database,
): Promise<AiSwitchesFacts> {
	const [switches, version] = await Promise.all([
		readAiSwitches(db),
		db
			.prepare(`SELECT ${AI_SWITCHES_VERSION} AS version`)
			.first<{ version: string }>(),
	]);

	return { switches, version: version?.version ?? "" };
}

/** The switches that changed, and with Sort on arrival's turn-on, the mark that the rows it left wait for the daily run (decision 150). */
// stays SQL: its statements come from ai-switches.ts and first-tally.ts; moves with D2b.
export const aiSwitchesStatements = (db: D1Database, save: AiSwitchesWrite) => {
	const waiting = save.rowsWaitFor && waitingForJevSql(save.rowsWaitFor);

	return [
		rawGuard(db, AI_SWITCHES_VERSION, save.expectedVersion),
		...aiSwitchStatements(db, save.changed),
		...(waiting ? [waitsForRunStatement(db, waiting)] : []),
	];
};

// One stored value each.

const setting = (db: D1Database, key: string, value: string) =>
	drizzle(db)
		.insert(householdSettings)
		.values({ key, value })
		.onConflictDoUpdate({
			target: householdSettings.key,
			set: { value: sql`excluded.value` },
		});

export const timeZoneStatements = (db: D1Database, save: { zone: string }) =>
	inOneBatch(setting(db, "time_zone", save.zone));

export const bankSignInEmailsStatements = (
	db: D1Database,
	save: { on: boolean },
) => inOneBatch(setting(db, "bank_sign_in_emails", save.on ? "on" : "off"));

// A sign-in address.

const ADDRESS_VERSION =
	"(SELECT COUNT(*) || ':' || COALESCE(MAX(removed_at), '') FROM household_members WHERE email = ?1)";

export async function addressFacts(db: D1Database, email: string) {
	const row = await db
		.prepare(
			`SELECT (SELECT COUNT(*) FROM household_members WHERE email = ?1) AS known, ${ADDRESS_VERSION} AS version`,
		)
		.bind(email)
		.first<{ known: number; version: string }>();

	return { known: row?.known === 1, version: row?.version ?? "" };
}

/** ADDRESS_VERSION as Drizzle SQL, for the Drizzle guard. The facts reader keeps the text form until it moves. */
const addressVersion = (email: string) =>
	sql`(SELECT COUNT(*) || ':' || COALESCE(MAX(${householdMembers.removedAt}), '') FROM ${householdMembers} WHERE ${householdMembers.email} = ${email})`;

export const removeAddressStatements = (
	db: D1Database,
	save: RemoveAddressWrite,
) =>
	inOneBatch(
		guardOrm(db, addressVersion(save.email), save.expectedVersion),
		drizzle(db)
			.update(householdMembers)
			.set({ removedAt: sql`datetime(${save.now} / 1000, 'unixepoch')` })
			.where(eq(householdMembers.email, save.email)),
		drizzle(db)
			.delete(pushSubscriptions)
			.where(eq(pushSubscriptions.memberEmail, save.email)),
	);

// The people of the household.

const PERSON_VERSION =
	"COALESCE((SELECT hex(name) FROM household_people WHERE id = ?1), 'none')";

export async function personFacts(
	db: D1Database,
	id: number,
): Promise<PersonFacts> {
	const row = await db
		.prepare(
			`SELECT (SELECT name FROM household_people WHERE id = ?1) AS name, ${PERSON_VERSION} AS version`,
		)
		.bind(id)
		.first<{ name: string | null; version: string }>();

	return { name: row?.name ?? null, version: row?.version ?? "" };
}

/** The table's own index refuses a name the household has, in any capitals. */
export const personNameTaken = () => new PersonNameTaken();

/** PERSON_VERSION as Drizzle SQL, for the Drizzle guard. The facts reader keeps the text form until it moves. */
const personVersion = (id: number) =>
	sql`COALESCE((SELECT hex(${householdPeople.name}) FROM ${householdPeople} WHERE ${householdPeople.id} = ${id}), 'none')`;

export const addPersonStatements = (db: D1Database, save: { name: string }) =>
	inOneBatch(drizzle(db).insert(householdPeople).values({ name: save.name }));

export const renamePersonStatements = (
	db: D1Database,
	save: RenamePersonWrite,
) =>
	inOneBatch(
		guardOrm(db, personVersion(save.id), save.expectedVersion),
		drizzle(db)
			.update(householdPeople)
			.set({ name: save.name })
			.where(eq(householdPeople.id, save.id)),
	);

/** The person's purchases have no cap, so one statement clears them all (decision 209); its result says how many. */
export const removePersonStatements = (
	db: D1Database,
	save: RemovePersonWrite,
) =>
	inOneBatch(
		guardOrm(db, personVersion(save.id), save.expectedVersion),
		drizzle(db)
			.update(transactions)
			.set({
				forPersonId: null,
				forPersonGuessed: 0,
				updatedBy: save.who,
				updatedAt: sql`datetime('now')`,
			})
			.where(eq(transactions.forPersonId, save.id)),
		drizzle(db).delete(householdPeople).where(eq(householdPeople.id, save.id)),
	);

// Tally's rules.

const ALWAYS_VERSION =
	"COALESCE((SELECT COALESCE(default_category_id, 'no rule') FROM merchants WHERE raw_name = ?1), 'none')";

export async function alwaysRuleFacts(
	db: D1Database,
	merchantKey: string,
): Promise<AlwaysRuleFacts> {
	const row = await db
		.prepare(
			`SELECT (SELECT COALESCE(NULLIF(display_name, ''), raw_name) FROM merchants
				WHERE raw_name = ?1 AND default_category_id IS NOT NULL) AS merchant, ${ALWAYS_VERSION} AS version`,
		)
		.bind(merchantKey)
		.first<{ merchant: string | null; version: string }>();

	return { merchant: row?.merchant ?? null, version: row?.version ?? "" };
}

// stays SQL: its statement is CLEAR_MERCHANT_RULE_SQL; moves with D2b.
export const removeAlwaysRuleStatements = (
	db: D1Database,
	save: RemoveAlwaysRuleWrite,
) => [
	rawGuard(db, ALWAYS_VERSION, save.expectedVersion, save.merchantKey),
	db.prepare(CLEAR_MERCHANT_RULE_SQL).bind(save.merchantKey),
];

const NEVER_VERSION =
	"COALESCE((SELECT hex(merchant_key) || ':' || kind FROM never_suggest_rules WHERE id = ?1), 'none')";

export async function neverSuggestLineFacts(
	db: D1Database,
	clicked: { id: number; merchantKey: string; kind: string },
): Promise<NeverSuggestLineFacts<NeverSuggestRule>> {
	const [line, version] = await Promise.all([
		neverSuggestLine(db, clicked),
		db
			.prepare(`SELECT ${NEVER_VERSION} AS version`)
			.bind(clicked.id)
			.first<{ version: string }>(),
	]);

	// A line read beside a version of another moment is caught by the guard, which checks the version again.
	return { line, version: version?.version ?? "" };
}

// stays SQL: its statement comes from never-suggest.ts; moves with D2b and D2d.
export const removeNeverSuggestStatements = (
	db: D1Database,
	save: RemoveNeverSuggestWrite<NeverSuggestRule>,
) => [
	rawGuard(db, NEVER_VERSION, save.expectedVersion, save.line.id),
	removeNeverSuggestStatement(db, save.line),
];

const removeLineRule = removeNeverSuggestLine<NeverSuggestRule>();

/**
 * A line's Remove, as the rule decides it, for a caller that wants the line and how many lines went with it: null when
 * the rule had nothing to do.
 */
export const removeNeverSuggest = (
	db: D1Database,
	clicked: { id: number; merchantKey: string; kind: string },
): Promise<{ rule: NeverSuggestRule; removedCount: number } | null> =>
	runWith(
		db,
		decideSetting(
			removeLineRule,
			{ id: clicked.id },
			(read) => neverSuggestLineFacts(read, clicked),
			removeNeverSuggestStatements,
		).pipe(
			Effect.map(({ decided, saved }) => {
				const write = Option.getOrNull(decided);

				// The statement that removes the lines is the batch's second, after the guard.
				return (
					write && {
						rule: write.line,
						removedCount: saved?.[1]?.meta.changes ?? 0,
					}
				);
			}),
		),
	);

// The learned lines.

/** A text's Forget and its rule as one text, as SQL (?1 the cleaned text). */
const TEXT_VERSION = `(COALESCE((SELECT forgotten_at || ':' || COALESCE(previous_forgotten_at, '') FROM forgotten_texts
	WHERE cleaned_text = ?1), 'none') || '/' || COALESCE((SELECT category_id FROM bank_text_rules WHERE cleaned_text = ?1), 'none'))`;

/** The version of a text's Forget and rule. Whether the text has a learned line is the page's own read. */
export async function textVersion(db: D1Database, text: string) {
	const row = await db
		.prepare(`SELECT ${TEXT_VERSION} AS version`)
		.bind(text)
		.first<{ version: string }>();

	return row?.version ?? "";
}

/** A time in milliseconds as SQLite's UTC text, to the millisecond, as SQL over the value bound at `mark`. */
const utc = (mark: string) =>
	`strftime('%Y-%m-%d %H:%M:%f', ${mark} / 1000.0, 'unixepoch')`;

/**
 * The Forget, one batch: it remembers the rule it removes (its Undo puts that rule back) and the time of an earlier
 * Forget, then the rule goes. The insert reads the rule before the delete, in order.
 */
// stays SQL: a Forget's own statements; moves with D2c.
export const forgetStatements = (db: D1Database, save: ForgetWrite) => [
	rawGuard(db, TEXT_VERSION, save.expectedVersion, save.text),
	db
		.prepare(
			`INSERT INTO forgotten_texts (cleaned_text, forgotten_at, rule_category_id)
			VALUES (?1, ${utc("?2")}, (SELECT category_id FROM bank_text_rules WHERE cleaned_text = ?1))
			ON CONFLICT(cleaned_text) DO UPDATE SET
				previous_forgotten_at = forgotten_texts.forgotten_at,
				forgotten_at = excluded.forgotten_at,
				rule_category_id = excluded.rule_category_id
			RETURNING id`,
		)
		.bind(save.text, save.now),
	db
		.prepare("DELETE FROM bank_text_rules WHERE cleaned_text = ?")
		.bind(save.text),
];

/** The time left on a Forget's Undo, in milliseconds, for a Forget made at `forgottenAt` and read at `now`. */
export const forgetUndoLeftMs = (forgottenAt: number, now: number) =>
	undoLeftMs(forgottenAt, now);

/** A Forget row's time in milliseconds, as SQL. */
const FORGOTTEN_MS =
	"CAST(ROUND((julianday(forgotten_at) - 2440587.5) * 86400000) AS INTEGER)";

const FORGET_VERSION =
	"COALESCE((SELECT forgotten_at || ':' || COALESCE(previous_forgotten_at, '') FROM forgotten_texts WHERE id = ?1), 'none')";

export async function undoForgetFacts(
	db: D1Database,
	id: number,
): Promise<UndoForgetFacts> {
	// SAFETY: the batch below lists exactly two statements, so its results are the two D1Results typed here.
	const [row, version] = (await db.batch([
		db
			.prepare(
				`SELECT ${FORGOTTEN_MS} AS atMs, previous_forgotten_at IS NOT NULL AS hadEarlier FROM forgotten_texts WHERE id = ?1`,
			)
			.bind(id),
		db.prepare(`SELECT ${FORGET_VERSION} AS version`).bind(id),
	])) as [
		D1Result<{ atMs: number; hadEarlier: number }>,
		D1Result<{ version: string }>,
	];

	const forgotten = row.results[0];

	return {
		forgotten: forgotten
			? { atMs: forgotten.atMs, hadEarlier: forgotten.hadEarlier === 1 }
			: null,
		version: version.results[0]?.version ?? "",
	};
}

/**
 * The Undo, one batch: the rule the Forget removed comes back, unless the text has a newer rule (ON CONFLICT keeps that
 * one), and the Forget's row goes back to its earlier time, or goes.
 */
// stays SQL: an Undo's own statements; moves with D2c.
export const undoForgetStatements = (db: D1Database, save: UndoForgetWrite) => [
	rawGuard(db, FORGET_VERSION, save.expectedVersion, save.id),
	db
		.prepare(
			`INSERT INTO bank_text_rules (cleaned_text, category_id)
			SELECT cleaned_text, rule_category_id FROM forgotten_texts
			WHERE id = ? AND rule_category_id IS NOT NULL
			ON CONFLICT(cleaned_text) DO NOTHING`,
		)
		.bind(save.id),
	save.backToEarlier
		? db
				.prepare(
					"UPDATE forgotten_texts SET forgotten_at = previous_forgotten_at, previous_forgotten_at = NULL, rule_category_id = NULL WHERE id = ?",
				)
				.bind(save.id)
		: db.prepare("DELETE FROM forgotten_texts WHERE id = ?").bind(save.id),
];

/** The chosen category (?2) and the text's rule (?1) as one text, as SQL. */
const CHANGE_VERSION = `(COALESCE((SELECT archived FROM categories WHERE id = ?2), 'none') || '/'
	|| COALESCE((SELECT category_id FROM bank_text_rules WHERE cleaned_text = ?1), 'none'))`;

/** What a Change reads beside the page's own line: the chosen category, with the version. */
export async function changeLineFacts(
	db: D1Database,
	text: string,
	categoryId: number,
	line: ChangeLineFacts["line"],
): Promise<ChangeLineFacts> {
	const row = await db
		.prepare(
			`SELECT c.id, c.name, c.archived, ${CHANGE_VERSION} AS version FROM (SELECT 1) LEFT JOIN categories c ON c.id = ?2`,
		)
		.bind(text, categoryId)
		.first<{
			id: number | null;
			name: string | null;
			archived: number | null;
			version: string;
		}>();

	return {
		line,
		category:
			row?.id == null
				? null
				: { id: row.id, name: row.name ?? "", archived: row.archived === 1 },
		version: row?.version ?? "",
	};
}

/**
 * A Change's batch: the guard, the rule, then the merchant rules and every bank-text rule's fill, so a merchant rule
 * still wins. The rows a rule fills have no cap, so SQL fills them (decision 209).
 */
// stays SQL: it uses merchantRuleStatement in transactions.ts; moves with D2e.
export const changeLineStatements = async (
	db: D1Database,
	save: ChangeLineWrite,
) => [
	rawGuard(
		db,
		CHANGE_VERSION,
		save.expectedVersion,
		save.text,
		save.categoryId,
	),
	...(await changeBankTextRuleStatements(db, save.text, save.categoryId)),
];

import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { beforeEach, describe, expect, it } from "vitest";
import { type Database, runWith } from "../src/db/database";
import {
	addPersonStatements,
	addressFacts,
	bankSignInEmailsStatements,
	decideSetting,
	noFacts,
	personFacts,
	personNameTaken,
	removeAddressStatements,
	removePersonStatements,
	renamePersonStatements,
	timeZoneStatements,
} from "../src/db/settings-saves";
import { resetDemo } from "../src/demo/reset";
import {
	addPerson,
	PersonNameTaken,
	removePerson,
	removeSignInAddress,
	renamePerson,
	saveBankSignInEmails,
	saveTimeZone,
} from "../src/rules/settings";

// The settings saves that run as one batch (src/db/settings-saves.ts), through the seam a handler uses: decideSetting
// reads the facts, asks the rule, and saves what it decides. The guard (decision 190) saves nothing when the facts the
// rule read have changed, and asks again on fresh facts.

const db = env.DB;
const TODAY = "2026-09-22";
const MEMBER = "guard-check@example.com";
const STALE = "stale";

const setting = async (key: string) =>
	(
		await db
			.prepare("SELECT value FROM household_settings WHERE key = ?")
			.bind(key)
			.first<{ value: string }>()
	)?.value ?? null;

const personNamed = async (name: string) =>
	(
		await db
			.prepare("SELECT id FROM household_people WHERE name = ?")
			.bind(name)
			.first<{ id: number }>()
	)?.id ?? null;

const addMember = async () => {
	await db
		.prepare("INSERT INTO household_members (email) VALUES (?)")
		.bind(MEMBER)
		.run();
	await db
		.prepare(
			"INSERT INTO push_subscriptions (member_email, endpoint, p256dh, auth) VALUES (?, ?, 'p', 'a')",
		)
		.bind(MEMBER, "https://push.example.test/guard-check")
		.run();
};

const memberRow = () =>
	db
		.prepare(
			"SELECT removed_at AS removedAt FROM household_members WHERE email = ?",
		)
		.bind(MEMBER)
		.first<{ removedAt: string | null }>();

const subscriptionCount = async () =>
	(
		await db
			.prepare(
				"SELECT COUNT(*) AS n FROM push_subscriptions WHERE member_email = ?",
			)
			.bind(MEMBER)
			.first<{ n: number }>()
	)?.n ?? 0;

/** Runs a decideSetting program and answers its success or its refusal, so a refusal is a value and not a rejection. */
const attempt = <A, E>(program: Effect.Effect<A, E, Database>) =>
	runWith(db, program.pipe(Effect.result)).then((result) =>
		Result.isSuccess(result) ? result.success : result.failure,
	);

beforeEach(async () => {
	await resetDemo(db, TODAY);
});

describe("settings saves that write one setting", () => {
	it("saves the time zone and leaves the other settings alone", async () => {
		await attempt(
			decideSetting(
				saveTimeZone,
				{ zone: "Europe/London" },
				noFacts,
				timeZoneStatements,
			),
		);

		expect(await setting("time_zone")).toBe("Europe/London");

		await attempt(
			decideSetting(
				saveTimeZone,
				{ zone: "America/New_York" },
				noFacts,
				timeZoneStatements,
			),
		);

		expect(await setting("time_zone")).toBe("America/New_York");
	});

	it.each([
		[true, "on"],
		[false, "off"],
	])("stores the bank sign-in emails switch for %s as %s", async (on, text) => {
		await attempt(
			decideSetting(
				saveBankSignInEmails,
				{ on },
				noFacts,
				bankSignInEmailsStatements,
			),
		);

		expect(await setting("bank_sign_in_emails")).toBe(text);
	});
});

describe("adding and renaming a person", () => {
	it("adds a person, and refuses a name the household already has in any capitals", async () => {
		const added = await attempt(
			decideSetting(
				addPerson,
				{ name: "Pat" },
				noFacts,
				addPersonStatements,
				personNameTaken,
			),
		);

		expect(added).toBeDefined();
		expect(await personNamed("Pat")).not.toBeNull();

		const taken = await attempt(
			decideSetting(
				addPerson,
				{ name: "PAT" },
				noFacts,
				addPersonStatements,
				personNameTaken,
			),
		);

		expect(taken).toBeInstanceOf(PersonNameTaken);
		expect(
			(
				await db
					.prepare("SELECT COUNT(*) AS n FROM household_people WHERE name = ?")
					.bind("Pat")
					.first<{ n: number }>()
			)?.n,
		).toBe(1);
	});

	it("renames a person to the name given", async () => {
		await attempt(
			decideSetting(
				addPerson,
				{ name: "Robin" },
				noFacts,
				addPersonStatements,
				personNameTaken,
			),
		);
		const id = await personNamed("Robin");

		expect(id).not.toBeNull();

		await attempt(
			decideSetting(
				renamePerson,
				{ id: id ?? 0, name: "Robyn" },
				(d) => personFacts(d, id ?? 0),
				renamePersonStatements,
			),
		);

		expect(await personNamed("Robyn")).toBe(id);
		expect(await personNamed("Robin")).toBeNull();
	});

	it("writes nothing when the person's facts changed since the rule read them", async () => {
		await attempt(
			decideSetting(
				addPerson,
				{ name: "Sam" },
				noFacts,
				addPersonStatements,
				personNameTaken,
			),
		);
		const id = await personNamed("Sam");

		// Every read is stale, so the guard refuses each try, and the decision gives up after its three tries.
		await expect(
			attempt(
				decideSetting(
					renamePerson,
					{ id: id ?? 0, name: "Samantha" },
					async () => ({ name: "Sam", version: STALE }),
					renamePersonStatements,
				),
			),
		).rejects.toThrow("A setting kept changing while it was being saved.");

		expect(await personNamed("Sam")).toBe(id);
		expect(await personNamed("Samantha")).toBeNull();
	});

	it("asks again on fresh facts after one stale read, and saves once", async () => {
		await attempt(
			decideSetting(
				addPerson,
				{ name: "Lee" },
				noFacts,
				addPersonStatements,
				personNameTaken,
			),
		);
		const id = await personNamed("Lee");
		let reads = 0;

		await attempt(
			decideSetting(
				renamePerson,
				{ id: id ?? 0, name: "Leigh" },
				async (d) => {
					reads++;

					return reads === 1
						? { name: "Lee", version: STALE }
						: personFacts(d, id ?? 0);
				},
				renamePersonStatements,
			),
		);

		expect(reads).toBe(2);
		expect(await personNamed("Leigh")).toBe(id);
	});
});

describe("removing a person", () => {
	it("clears their purchases and removes them", async () => {
		await attempt(
			decideSetting(
				addPerson,
				{ name: "Kit" },
				noFacts,
				addPersonStatements,
				personNameTaken,
			),
		);
		const id = await personNamed("Kit");

		await db
			.prepare(
				"UPDATE transactions SET for_person_id = ?, for_person_guessed = 1 WHERE id IN (SELECT id FROM transactions ORDER BY id LIMIT 2)",
			)
			.bind(id)
			.run();

		await attempt(
			decideSetting(
				removePerson,
				{ id: id ?? 0, who: "owner@example.com" },
				(d) => personFacts(d, id ?? 0),
				removePersonStatements,
			),
		);

		expect(await personNamed("Kit")).toBeNull();

		const cleared = await db
			.prepare(
				"SELECT COUNT(*) AS n FROM transactions WHERE for_person_id IS NULL AND for_person_guessed = 0 AND updated_by = 'owner@example.com'",
			)
			.first<{ n: number }>();

		expect(cleared?.n).toBe(2);
	});

	it("writes nothing when the person's facts changed since the rule read them", async () => {
		await attempt(
			decideSetting(
				addPerson,
				{ name: "Jo" },
				noFacts,
				addPersonStatements,
				personNameTaken,
			),
		);
		const id = await personNamed("Jo");

		await expect(
			attempt(
				decideSetting(
					removePerson,
					{ id: id ?? 0, who: "owner@example.com" },
					async () => ({ name: "Jo", version: STALE }),
					removePersonStatements,
				),
			),
		).rejects.toThrow("A setting kept changing while it was being saved.");

		expect(await personNamed("Jo")).toBe(id);
	});
});

describe("removing a sign-in address", () => {
	it("marks the address removed and drops its push subscriptions", async () => {
		await addMember();
		expect(await subscriptionCount()).toBe(1);

		await attempt(
			decideSetting(
				removeSignInAddress,
				{ email: MEMBER, now: Date.UTC(2026, 8, 22, 12) },
				(d) => addressFacts(d, MEMBER),
				removeAddressStatements,
			),
		);

		expect((await memberRow())?.removedAt).toBe("2026-09-22 12:00:00");
		expect(await subscriptionCount()).toBe(0);
	});

	it("writes nothing when the address's facts changed since the rule read them", async () => {
		await addMember();

		await expect(
			attempt(
				decideSetting(
					removeSignInAddress,
					{ email: MEMBER, now: Date.UTC(2026, 8, 22, 12) },
					async () => ({ known: true, version: STALE }),
					removeAddressStatements,
				),
			),
		).rejects.toThrow("A setting kept changing while it was being saved.");

		expect((await memberRow())?.removedAt).toBeNull();
		expect(await subscriptionCount()).toBe(1);
	});
});

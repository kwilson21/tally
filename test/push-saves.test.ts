import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/database";
import {
	decideDevice,
	deviceFacts,
	deviceSaveStatements,
	devicesChangedSinceRead,
} from "../src/db/push-saves";
import { type DeviceRequest, subscribeDevice } from "../src/rules/push";

// The push area's guard (decision 190): a device is stored only while what the rule read about the person and the
// device is still true, and a miss raises an error the save loop recognises, so the rule is asked again.

const db = env.DB;
const ME = "person@example.com";
const RILEY = "riley@example.com";
const NOW = "2026-11-12 15:00:00";

const deviceAt = (n: number) =>
	`https://fcm.googleapis.com/fcm/send/device-${n}`;

const request: DeviceRequest = {
	member: ME,
	endpoint: deviceAt(9),
	p256dh: "key",
	auth: "secret",
	restore: false,
	now: NOW,
};

const seed = (email: string, n: number, createdAt: string) =>
	db
		.prepare(
			"INSERT INTO push_subscriptions (member_email, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'k', 'a', ?)",
		)
		.bind(email, deviceAt(n), createdAt)
		.run();

const rows = async () =>
	(
		await db
			.prepare(
				"SELECT member_email AS member, endpoint, p256dh, auth, created_at AS createdAt FROM push_subscriptions ORDER BY endpoint",
			)
			.all<{ member: string; endpoint: string; createdAt: string }>()
	).results;

const removeMe = () =>
	db
		.prepare("UPDATE household_members SET removed_at = ?1 WHERE email = ?2")
		.bind(NOW, ME)
		.run();

/** The error a batch fails with, or null when it runs. */
const raised = async (statements: D1PreparedStatement[]) => {
	try {
		await db.batch(statements);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}

	return null;
};

beforeEach(async () => {
	await db.batch([
		db.prepare("DELETE FROM push_subscriptions"),
		db.prepare("DELETE FROM household_members"),
		db
			.prepare(
				"INSERT INTO household_members (email, last_seen_at) VALUES (?1, ?3), (?2, ?3)",
			)
			.bind(ME, RILEY, NOW),
	]);
});

describe("what the push rule reads", () => {
	it("reads the member, the endpoint's row and the person's other devices", async () => {
		await seed(RILEY, 9, "2026-01-01 09:00:00");
		await seed(ME, 1, "2026-01-02 09:00:00");
		await seed(RILEY, 2, "2026-01-03 09:00:00");
		const facts = await deviceFacts(db, ME, deviceAt(9));

		expect(facts).toMatchObject({
			isMember: true,
			device: { owner: RILEY },
			others: [{ createdAt: "2026-01-02 09:00:00" }],
		});
		expect(facts.others).toHaveLength(1);
	});

	it("reads a removed person as not a member, and a missing device as none", async () => {
		await removeMe();

		expect(await deviceFacts(db, ME, deviceAt(9))).toMatchObject({
			isMember: false,
			device: null,
			others: [],
		});
	});

	it.each([
		["the person is removed", removeMe],
		["the device is stored for someone", () => seed(RILEY, 9, NOW)],
		["the person gets another device", () => seed(ME, 1, NOW)],
		[
			"one of the person's devices is stamped again",
			async () => {
				await db
					.prepare("UPDATE push_subscriptions SET created_at = ?")
					.bind(NOW)
					.run();
			},
		],
	])("has a new version once %s", async (_what, change) => {
		await seed(ME, 5, "2026-01-01 09:00:00");
		const before = (await deviceFacts(db, ME, deviceAt(9))).version;

		await change();
		expect((await deviceFacts(db, ME, deviceAt(9))).version).not.toBe(before);
	});

	it("keeps its version when someone else's other device changes", async () => {
		const before = (await deviceFacts(db, ME, deviceAt(9))).version;

		await seed(RILEY, 2, NOW);
		expect((await deviceFacts(db, ME, deviceAt(9))).version).toBe(before);
	});
});

describe("the save", () => {
	it("stores the device as the person's newest and drops the devices the rule named", async () => {
		await seed(ME, 1, "2026-01-01 09:00:00");
		await seed(ME, 2, "2026-01-02 09:00:00");
		const facts = await deviceFacts(db, ME, deviceAt(9));

		const oldest = facts.others.find((d) =>
			d.createdAt.startsWith("2026-01-01"),
		);

		await db.batch(
			deviceSaveStatements(db, {
				...request,
				drop: oldest ? [oldest.id] : [],
				expectedVersion: facts.version,
			}),
		);
		expect(await rows()).toEqual([
			{
				member: ME,
				endpoint: deviceAt(2),
				p256dh: "k",
				auth: "a",
				createdAt: "2026-01-02 09:00:00",
			},
			{
				member: ME,
				endpoint: deviceAt(9),
				p256dh: "key",
				auth: "secret",
				createdAt: NOW,
			},
		]);
	});

	it("never drops another person's device, whatever id it is given", async () => {
		await seed(RILEY, 1, "2026-01-01 09:00:00");
		const theirs = await deviceFacts(db, RILEY, deviceAt(9));
		const mine = await deviceFacts(db, ME, deviceAt(9));

		await db.batch(
			deviceSaveStatements(db, {
				...request,
				drop: theirs.others.map((d) => d.id),
				expectedVersion: mine.version,
			}),
		);
		expect((await rows()).map((r) => r.member)).toEqual([RILEY, ME]);
	});

	it("raises the guard's error, and stores nothing, when the person was removed after the read", async () => {
		const { version } = await deviceFacts(db, ME, deviceAt(9));

		await removeMe();

		const error = await raised(
			deviceSaveStatements(db, {
				...request,
				drop: [],
				expectedVersion: version,
			}),
		);

		expect(error !== null && devicesChangedSinceRead(error)).toBe(true);
		expect(await rows()).toEqual([]);
	});

	it("does not take another failure for the guard's", () => {
		expect(
			devicesChangedSinceRead(
				new Error("NOT NULL constraint failed: push_subscriptions.endpoint"),
			),
		).toBe(false);
	});
});

describe("decideDevice", () => {
	const run = <A, E>(program: Effect.Effect<A, E, Database>) =>
		Effect.runPromise(program.pipe(Effect.provideService(Database, db)));

	it("stores what the rule decided", async () => {
		const { decided } = await run(decideDevice(subscribeDevice, request));

		expect(Option.isSome(decided)).toBe(true);
		expect((await rows()).map((r) => r.member)).toEqual([ME]);
	});

	it("stores nothing for a person removed between the read and the save, and the rule then refuses", async () => {
		let asked = 0;

		// The first read is from before the removal: its version no longer matches, so the save raises.
		const stale = await deviceFacts(db, ME, deviceAt(9));

		await removeMe();

		const late = await run(
			decideDevice(
				{
					decide: (r, facts) => {
						asked++;

						return subscribeDevice.decide(r, asked === 1 ? stale : facts);
					},
				},
				request,
			).pipe(
				Effect.match({
					onFailure: (refusal) => refusal._tag,
					onSuccess: () => "saved",
				}),
			),
		);

		expect(asked).toBe(2);
		expect(late).toBe("NotAMember");
		expect(await rows()).toEqual([]);
	});
});

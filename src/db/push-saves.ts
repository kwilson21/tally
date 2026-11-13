// How the push rule (src/rules/push.ts) reads its facts and saves what it decides (decisions 190 and 206). The rule decides in
// TypeScript; the database only checks that what the rule read has not changed since, and raises an error when it has,
// so a device is never stored for a person removed a moment earlier, and the cap is never worked out on stale rows.
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { DeviceFacts, DeviceRequest, DeviceWrite } from "../rules/push";
import { Database } from "./database";
import { ChangedSinceRead, decideAndSave } from "./guarded-save";
import { leftEmpty } from "./refused";

/** Whether the person (?1) is a member now, as SQL: 1 or 0. */
const IS_MEMBER =
	"(SELECT COUNT(*) FROM household_members WHERE email = ?1 AND removed_at IS NULL)";

/**
 * Everything the rule reads as one text, as SQL (?1 the person, ?2 the endpoint): whether they are a member, the
 * endpoint's row and its owner, and each of the person's devices with its time. The owner is in hex, so no address can
 * look like the marks between the parts.
 */
const VERSION = `(SELECT ${IS_MEMBER} || '/'
	|| COALESCE((SELECT id || ':' || hex(member_email) FROM push_subscriptions WHERE endpoint = ?2), '') || '/'
	|| COALESCE((SELECT group_concat(id || ':' || created_at, '|')
		FROM (SELECT id, created_at FROM push_subscriptions WHERE member_email = ?1 ORDER BY id)), ''))`;

/** What the push rule reads about a person and an endpoint, with its version, in one batch (one transaction). */
export async function deviceFacts(
	db: D1Database,
	member: string,
	endpoint: string,
): Promise<DeviceFacts> {
	// SAFETY: the batch below lists exactly three statements, so its results are the three D1Results typed here.
	const [state, device, others] = (await db.batch([
		db
			.prepare(`SELECT ${IS_MEMBER} AS isMember, ${VERSION} AS version`)
			.bind(member, endpoint),
		db
			.prepare(
				"SELECT id, member_email AS owner FROM push_subscriptions WHERE endpoint = ?",
			)
			.bind(endpoint),
		db
			.prepare(
				"SELECT id, created_at AS createdAt FROM push_subscriptions WHERE member_email = ?1 AND endpoint <> ?2",
			)
			.bind(member, endpoint),
	])) as [
		D1Result<{ isMember: number; version: string }>,
		D1Result<{ id: number; owner: string }>,
		D1Result<{ id: number; createdAt: string }>,
	];

	return {
		isMember: state.results[0]?.isMember === 1,
		device: device.results[0] ?? null,
		others: others.results,
		version: state.results[0]?.version ?? "",
	};
}

/**
 * The save, one batch. First the guard: it adds nothing while the stored rows are still the ones the rule read, and
 * tries to add a device for nobody when they are not. member_email is NOT NULL, so that fails the statement and the
 * whole batch with an error devicesChangedSinceRead knows (SQLite's RAISE works only inside a trigger). Then the device
 * is stored for the person as their newest, and the devices the rule named are dropped.
 */
export const deviceSaveStatements = (db: D1Database, save: DeviceWrite) => [
	db
		.prepare(
			`INSERT INTO push_subscriptions (member_email, endpoint, p256dh, auth) SELECT NULL, ?2, '', '' WHERE ${VERSION} IS NOT ?3`,
		)
		.bind(save.member, save.endpoint, save.expectedVersion),
	db
		.prepare(
			`INSERT INTO push_subscriptions (member_email, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, datetime(?5))
			ON CONFLICT(endpoint) DO UPDATE SET member_email = excluded.member_email, p256dh = excluded.p256dh,
				auth = excluded.auth, created_at = excluded.created_at`,
		)
		.bind(save.member, save.endpoint, save.p256dh, save.auth, save.now),
	db
		.prepare(
			"DELETE FROM push_subscriptions WHERE member_email = ?1 AND id IN (SELECT value FROM json_each(?2))",
		)
		.bind(save.member, JSON.stringify(save.drop)),
];

/** Whether a save failed because what the rule read had changed, and not for any other reason. Only the guard can try to store a device for nobody. */
export const devicesChangedSinceRead = leftEmpty(
	"push_subscriptions",
	"member_email",
);

/**
 * Reads the facts, asks the rule and saves what it decides in one batch, asking again on fresh facts when the guard
 * raises (decideAndSave).
 */
export const decideDevice = <E>(
	deviceRule: {
		decide: (
			request: DeviceRequest,
			facts: DeviceFacts,
		) => Effect.Effect<Option.Option<DeviceWrite>, E>;
	},
	request: DeviceRequest,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* decideAndSave({
			facts: Effect.promise(() =>
				deviceFacts(db, request.member, request.endpoint),
			),
			decide: (facts) => deviceRule.decide(request, facts),
			save: (write) =>
				Effect.tryPromise({
					try: () => db.batch(deviceSaveStatements(db, write)),
					catch: (cause) => cause,
				}).pipe(
					Effect.catch((cause) =>
						cause instanceof Error && devicesChangedSinceRead(cause)
							? Effect.fail(new ChangedSinceRead())
							: Effect.die(cause),
					),
				),
			gaveUp: "The person's devices kept changing while one was being saved.",
		});
	});

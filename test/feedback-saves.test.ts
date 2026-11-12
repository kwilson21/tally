import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/db/database";
import {
	decideFeedback,
	feedbackChangedSinceRead,
	feedbackFacts,
	feedbackSaveStatement,
} from "../src/db/feedback-saves";
import { type FeedbackRequest, sendFeedback } from "../src/rules/feedback";

// The feedback area's guard (decision 190): a message is stored only while its sender is still under the hour's limit
// the rule checked, and a miss raises an error the save loop recognises, so the rule is asked again and refuses.

const db = env.DB;
const SENDER = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-11-12 15:00:00";

const request: FeedbackRequest = {
	sender: SENDER,
	now: NOW,
	type: "Bug",
	feeling: "Okay",
	message: "The chart is cut off.",
	typedLength: 21,
	reviewed: true,
	page: "/trends",
	device: "Desktop browser",
	clientContext: null,
	appVersion: "v1",
};

const save = { ...request, sender: SENDER, sentThisHourBelow: 10 };

const store = (at: string, actor = SENDER) =>
	db
		.prepare(
			"INSERT INTO feedback (actor, created_at, type, feeling, message, page, device) VALUES (?, ?, 'Bug', 'Okay', 'old', '/', 'Unknown')",
		)
		.bind(actor, at)
		.run();

const stored = async () =>
	(
		await db
			.prepare(
				"SELECT actor, created_at AS createdAt, type, feeling, message, page, device, client_context AS clientContext, app_version AS appVersion FROM feedback WHERE message <> 'old'",
			)
			.all()
	).results;

beforeEach(async () => {
	await db.prepare("DELETE FROM feedback").run();
});

describe("what the feedback rule reads", () => {
	it("counts the sender's messages in the hour before the send, and nobody else's", async () => {
		await store("2026-11-12 14:00:00");
		await store("2026-11-12 14:00:01");
		await store("2026-11-12 14:59:59");
		await store("2026-11-12 14:30:00", "another-form");

		expect(await feedbackFacts(db, SENDER, NOW)).toEqual({ sentThisHour: 2 });
		expect(await feedbackFacts(db, null, NOW)).toEqual({ sentThisHour: 0 });
	});
});

describe("the save", () => {
	it("stores the message at the time it was given", async () => {
		await feedbackSaveStatement(db, save).run();

		expect(await stored()).toEqual([
			{
				actor: SENDER,
				createdAt: NOW,
				type: "Bug",
				feeling: "Okay",
				message: "The chart is cut off.",
				page: "/trends",
				device: "Desktop browser",
				clientContext: null,
				appVersion: "v1",
			},
		]);
	});

	it("raises the guard's error, and stores nothing, once the hour has filled up", async () => {
		for (let i = 0; i < 10; i++) await store("2026-11-12 14:30:00");
		let error: Error | null = null;

		try {
			await feedbackSaveStatement(db, save).run();
		} catch (caught) {
			error = caught instanceof Error ? caught : new Error(String(caught));
		}

		expect(error !== null && feedbackChangedSinceRead(error)).toBe(true);
		expect(await stored()).toEqual([]);
	});

	it("does not take another failure for the guard's", () => {
		expect(
			feedbackChangedSinceRead(
				new Error("NOT NULL constraint failed: feedback.actor"),
			),
		).toBe(false);
	});
});

describe("decideFeedback", () => {
	const run = <A, E>(program: Effect.Effect<A, E, Database>) =>
		Effect.runPromise(program.pipe(Effect.provideService(Database, db)));

	it("stores what the rule decided and answers with the new row's id", async () => {
		const { decided, saved } = await run(decideFeedback(sendFeedback, request));

		const row = await db
			.prepare("SELECT id FROM feedback")
			.first<{ id: number }>();

		expect(Option.isSome(decided)).toBe(true);
		expect(saved).toBe(row?.id);
	});

	it("fails with the rule's refusal and stores nothing", async () => {
		const refused = await run(
			decideFeedback(sendFeedback, { ...request, reviewed: false }).pipe(
				Effect.match({
					onFailure: (refusal) => refusal._tag,
					onSuccess: () => "saved",
				}),
			),
		);

		expect(refused).toBe("NotReviewed");
		expect(await stored()).toEqual([]);
	});

	it("asks the rule again when the hour fills up between its read and its save, and the rule then refuses", async () => {
		for (let i = 0; i < 10; i++) await store("2026-11-12 14:30:00");
		let asked = 0;

		const late = await run(
			decideFeedback(
				{
					decide: (r, facts) => {
						asked++;

						// The first read is one message behind: another send landed just after it.
						return sendFeedback.decide(r, {
							sentThisHour: asked === 1 ? 9 : facts.sentThisHour,
						});
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
		expect(late).toBe("TooManyThisHour");
		expect(await stored()).toEqual([]);
	});
});

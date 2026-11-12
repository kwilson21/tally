// How the feedback rule (src/rules/feedback.ts) reads its fact and saves what it decides (decisions 190 and 206). The rule
// decides in TypeScript; the database only checks that the sender is still under the hour's limit the rule checked, and
// raises an error when they are not, so two sends at once cannot both be the tenth.
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type {
	FeedbackFacts,
	FeedbackRequest,
	FeedbackWrite,
} from "../rules/feedback";
import { Database } from "./database";
import { ChangedSinceRead, decideAndSave } from "./guarded-save";

/** How many messages a sender (?1) has stored in the hour before a time (?2), as SQL. */
const SENT_THIS_HOUR =
	"(SELECT COUNT(*) FROM feedback WHERE actor = ?1 AND created_at > datetime(?2, '-1 hour'))";

/** What the feedback rule reads: the sender's messages in the hour before `now`. A form with no sender has none. */
export async function feedbackFacts(
	db: D1Database,
	sender: string | null,
	now: string,
): Promise<FeedbackFacts> {
	if (sender === null) return { sentThisHour: 0 };

	const row = await db
		.prepare(`SELECT ${SENT_THIS_HOUR} AS sentThisHour`)
		.bind(sender, now)
		.first<FeedbackFacts>();

	return { sentThisHour: row?.sentThisHour ?? 0 };
}

/**
 * The statement that stores a message. Its guard: the message is NULL unless the sender still has fewer stored this hour
 * than the rule's limit, and the column is NOT NULL, so a miss fails the statement with an error feedbackChangedSinceRead
 * knows. SQLite's RAISE works only inside a trigger, so the NOT NULL failure is how a plain statement raises.
 */
export function feedbackSaveStatement(
	db: D1Database,
	save: FeedbackWrite,
): D1PreparedStatement {
	return db
		.prepare(
			`INSERT INTO feedback (actor, created_at, type, feeling, message, page, device, client_context, app_version)
			SELECT ?1, datetime(?2), ?3, ?4, CASE WHEN ${SENT_THIS_HOUR} < ?10 THEN ?5 END, ?6, ?7, ?8, ?9`,
		)
		.bind(
			save.sender,
			save.now,
			save.type,
			save.feeling,
			save.message,
			save.page,
			save.device,
			save.clientContext,
			save.appVersion,
			save.sentThisHourBelow,
		);
}

/** The text of the guard's failure, as D1 passes SQLite's message on. Only the statement above can write a NULL message. */
const GUARD_RAISED = /NOT NULL constraint failed: feedback\.message/;

/** Whether a save failed because the sender's hour had filled up since the rule read it, and not for any other reason. */
export function feedbackChangedSinceRead(error: Error): boolean {
	return GUARD_RAISED.test(error.message);
}

/**
 * Reads the sender's count, asks the rule and stores the message, asking again on a fresh count when the guard raises
 * (decideAndSave). What it saved is the new row's id.
 */
export const decideFeedback = <E>(
	feedbackRule: {
		decide: (
			request: FeedbackRequest,
			facts: FeedbackFacts,
		) => Effect.Effect<Option.Option<FeedbackWrite>, E>;
	},
	request: FeedbackRequest,
) =>
	Effect.gen(function* () {
		const db = yield* Database;

		return yield* decideAndSave({
			facts: Effect.promise(() =>
				feedbackFacts(db, request.sender, request.now),
			),
			decide: (facts) => feedbackRule.decide(request, facts),
			save: (write) =>
				Effect.tryPromise({
					try: () => feedbackSaveStatement(db, write).run(),
					catch: (cause) => cause,
				}).pipe(
					Effect.map((result) => Number(result.meta.last_row_id)),
					Effect.catch((cause) =>
						cause instanceof Error && feedbackChangedSinceRead(cause)
							? Effect.fail(new ChangedSinceRead())
							: Effect.die(cause),
					),
				),
			gaveUp: "Feedback kept arriving while a message was being saved.",
		});
	});

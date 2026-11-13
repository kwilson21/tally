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
import { leftEmpty } from "./refused";

/** How many messages a sender has stored in the hour before a time, as SQL over those two parameters. */
const sentThisHour = (sender: string, now: string) =>
	`(SELECT COUNT(*) FROM feedback WHERE actor = ${sender} AND created_at > datetime(${now}, '-1 hour'))`;

/** What the feedback rule reads: the sender's messages in the hour before `now`. A form with no sender has none. */
export async function feedbackFacts(
	db: D1Database,
	sender: string | null,
	now: string,
): Promise<FeedbackFacts> {
	if (sender === null) return { sentThisHour: 0 };

	const row = await db
		.prepare(`SELECT ${sentThisHour("?1", "?2")} AS sentThisHour`)
		.bind(sender, now)
		.first<FeedbackFacts>();

	return { sentThisHour: row?.sentThisHour ?? 0 };
}

/**
 * The statement that stores a message. Its guard: the message is NULL unless the sender still has fewer stored this hour
 * than the rule's limit, and the column is NOT NULL, so a miss fails the statement with an error feedbackChangedSinceRead
 * knows. SQLite's RAISE works only inside a trigger, so the NOT NULL failure is how a plain statement raises.
 *
 * The technical context's column is named only when there is context to store, so with diagnostics off the statement
 * never mentions it (verification/feedback-integration.test.ts holds that). The first six values keep the places that
 * suite reads them at: the sender, the kind, the feeling, the cleaned message, the page and the device.
 */
export function feedbackSaveStatement(
	db: D1Database,
	save: FeedbackWrite,
): D1PreparedStatement {
	const withContext = save.clientContext !== null;

	return db
		.prepare(
			`INSERT INTO feedback (actor, type, feeling, message, page, device, created_at, app_version${withContext ? ", client_context" : ""})
			SELECT ?1, ?2, ?3, CASE WHEN ${sentThisHour("?1", "?7")} < ?9 THEN ?4 END, ?5, ?6, datetime(?7), ?8${withContext ? ", ?10" : ""}`,
		)
		.bind(
			save.sender,
			save.type,
			save.feeling,
			save.message,
			save.page,
			save.device,
			save.now,
			save.appVersion,
			save.sentThisHourBelow,
			...(withContext ? [save.clientContext] : []),
		);
}

/**
 * Whether a save failed because the sender's hour had filled up since the rule read it, and not for any other reason.
 * Only the statement above can write a NULL message.
 */
export const feedbackChangedSinceRead = leftEmpty("feedback", "message");

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

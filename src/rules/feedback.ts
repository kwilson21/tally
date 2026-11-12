// The feedback area's rule (decisions 187 and 206): send a feedback message. It takes a typed request and how many
// messages the sender has stored this hour, and answers what to save. The time and the sender are inputs
// (decision 195), and nothing here parses, reads a clock or touches the database. The save's guard is in
// src/db/feedback-saves.ts (decision 190).

import * as Data from "effect/Data";
import { FEEDBACK_MESSAGE_MAX } from "../limits";
import { rule, term, unless } from "./terms";

/** How many messages one sender may store in an hour. */
export const MAX_FEEDBACK_AN_HOUR = 10;

export type FeedbackRequest = {
	/** The form's own id from its cookie, or null when the form has expired. It is not a person. */
	sender: string | null;
	/** The time of the send, as SQLite writes it in UTC: YYYY-MM-DD HH:MM:SS. */
	now: string;
	type: string;
	feeling: string;
	/** The message, cleaned of private details. */
	message: string;
	/** How long the message was as typed, and 0 for one that was only spaces. */
	typedLength: number;
	reviewed: boolean;
	page: string;
	device: string;
	clientContext: string | null;
	appVersion: string | null;
};

export type FeedbackFacts = { sentThisHour: number };

/**
 * What the rule saves: the message, good only while the sender still has fewer than `sentThisHourBelow` stored this
 * hour. The save checks the limit itself and not the exact count the rule read, so sends at the same moment all land
 * until the hour is full, and none is turned away only because another arrived first.
 */
export type FeedbackWrite = Omit<
	FeedbackRequest,
	"sender" | "typedLength" | "reviewed"
> & { sender: string; sentThisHourBelow: number };

// The refusals: one class each, with the sentence a person reads.

export class FormExpired extends Data.TaggedError("FormExpired") {
	readonly say =
		"Your form expired. Review the cleaned message and send again.";
}

export class MessageTooLong extends Data.TaggedError("MessageTooLong") {
	readonly say =
		`Keep the message to ${FEEDBACK_MESSAGE_MAX.toLocaleString("en-US")} characters.`;
}

export class NoMessage extends Data.TaggedError("NoMessage") {
	readonly say = "Write a message before sending.";
}

export class NotReviewed extends Data.TaggedError("NotReviewed") {
	readonly say = "Review the cleaned message, confirm below, and send again.";
}

export class TooManyThisHour extends Data.TaggedError("TooManyThisHour") {
	readonly say =
		`You've sent ${MAX_FEEDBACK_AN_HOUR} messages this hour. Try again later.`;
}

type Given = FeedbackRequest & FeedbackFacts;

// Every send is a new message, so the rule names no nothing-to-do term.
export const sendFeedback = rule({
	name: "Send feedback",
	given: (request: FeedbackRequest, facts: FeedbackFacts): Given => ({
		...request,
		...facts,
	}),
	refusals: [
		unless(
			term<Given>("the form has not expired", (g) => g.sender !== null),
			() => new FormExpired(),
		),
		unless(
			term<Given>(
				`the message as typed is ${FEEDBACK_MESSAGE_MAX.toLocaleString("en-US")} characters or fewer`,
				(g) => g.typedLength <= FEEDBACK_MESSAGE_MAX,
			),
			() => new MessageTooLong(),
		),
		unless(
			term<Given>(
				"there is a message, as typed and once cleaned",
				(g) => g.typedLength > 0 && g.message !== "",
			),
			() => new NoMessage(),
		),
		unless(
			term<Given>(
				"the person has reviewed the cleaned message",
				(g) => g.reviewed,
			),
			() => new NotReviewed(),
		),
		unless(
			term<Given>(
				`the sender has stored fewer than ${MAX_FEEDBACK_AN_HOUR} messages this hour`,
				(g) => g.sentThisHour < MAX_FEEDBACK_AN_HOUR,
			),
			() => new TooManyThisHour(),
		),
	],
	writes: (g): FeedbackWrite => {
		// The first refusal has already answered for a form with no sender.
		if (g.sender === null) throw new Error("Feedback with no sender.");

		return {
			sender: g.sender,
			now: g.now,
			type: g.type,
			feeling: g.feeling,
			message: g.message,
			page: g.page,
			device: g.device,
			clientContext: g.clientContext,
			appVersion: g.appVersion,
			sentThisHourBelow: MAX_FEEDBACK_AN_HOUR,
		};
	},
	writesText:
		"Stores the cleaned message with its kind, feeling, page and device.",
});

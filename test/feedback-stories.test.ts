import { describe, expect, it } from "vitest";
import { readFeedbackForm } from "../src/feedback/form";
import { type FeedbackRequest, sendFeedback } from "../src/rules/feedback";
import { answerOf, refuse, write } from "./helpers/rule-answers";

// The feedback area's one rule as stories (decisions 187, 206): each row is what was asked, what was stored, and what
// the rule answers. The time and the sender are inputs (decision 195); nothing here touches a clock or a database.

const SENDER = "123e4567-e89b-12d3-a456-426614174000";
const NOW = "2026-11-12 15:00:00";

const asked = (over: Partial<FeedbackRequest> = {}): FeedbackRequest => ({
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
	appVersion: "v2026.11.12 abc1234",
	...over,
});

const SAVES = write({
	sender: SENDER,
	now: NOW,
	type: "Bug",
	feeling: "Okay",
	message: "The chart is cut off.",
	page: "/trends",
	device: "Desktop browser",
	clientContext: null,
	appVersion: "v2026.11.12 abc1234",
	sentThisHourBelow: 10,
});

const EXPIRED = refuse(
	"FormExpired",
	"Your form expired. Review the cleaned message and send again.",
);

const TOO_LONG = refuse(
	"MessageTooLong",
	"Keep the message to 2,000 characters.",
);

const NO_MESSAGE = refuse("NoMessage", "Write a message before sending.");

const NOT_REVIEWED = refuse(
	"NotReviewed",
	"Review the cleaned message, confirm below, and send again.",
);

const TOO_MANY = refuse(
	"TooManyThisHour",
	"You've sent 10 messages this hour. Try again later.",
);

describe("Send feedback", () => {
	it.each([
		["saves a first message", asked(), 0, SAVES],
		["saves a tenth message this hour", asked(), 9, SAVES],
		["refuses an eleventh message this hour", asked(), 10, TOO_MANY],
		["refuses a form with no sender", asked({ sender: null }), 0, EXPIRED],
		[
			"says the form expired before anything about the message",
			asked({ sender: null, message: "", typedLength: 0 }),
			0,
			EXPIRED,
		],
		[
			"refuses a message that is too long as typed",
			asked({ typedLength: 2001 }),
			0,
			TOO_LONG,
		],
		[
			"refuses an empty message",
			asked({ message: "", typedLength: 0 }),
			0,
			NO_MESSAGE,
		],
		[
			"refuses a message with nothing left once it is cleaned",
			asked({ message: "", typedLength: 40 }),
			0,
			NO_MESSAGE,
		],
		[
			"says a long run of spaces is too long, not empty",
			asked({ message: "", typedLength: 3000 }),
			0,
			TOO_LONG,
		],
		[
			"refuses a message the person has not reviewed",
			asked({ reviewed: false }),
			0,
			NOT_REVIEWED,
		],
		[
			"asks for the review before it says the hour is full",
			asked({ reviewed: false }),
			10,
			NOT_REVIEWED,
		],
	])("%s", (_story, request, sentThisHour, answer) => {
		expect(answerOf(sendFeedback.decide(request, { sentThisHour }))).toEqual(
			answer,
		);
	});
});

describe("the edge", () => {
	const read = (fields: Record<string, string>) => {
		const form = new FormData();

		for (const [key, value] of Object.entries(fields)) form.set(key, value);

		return readFeedbackForm(form);
	};

	it("reads a full form into a typed request", () => {
		expect(
			read({
				type: "Idea",
				feeling: "Happy",
				message: "A chart by week.\r\nPlease.",
				from: "/trends?month=2026-10",
				return_to: "/trends?month=2026-10",
				message_reviewed: "A chart by week.\nPlease.",
				confirm_review: "yes",
				device_category: "Mobile browser",
			}),
		).toEqual({
			type: "Idea",
			feeling: "Happy",
			message: "A chart by week.\nPlease.",
			typedLength: 24,
			reviewed: true,
			from: "/trends",
			returnTo: "/trends?month=2026-10",
			device: "Mobile browser",
			clientContext: null,
		});
	});

	it("falls back for a kind, a feeling, a device and a page it does not know", () => {
		expect(
			read({
				type: "Rant",
				feeling: "Furious",
				message: "x",
				from: "https://example.com/elsewhere",
				device_category: "Fridge",
			}),
		).toMatchObject({
			type: "Other",
			feeling: "Okay",
			device: "Unknown",
			returnTo: "/",
			reviewed: false,
		});
	});

	it("counts the review only when the cleaned text matches and the box is ticked", () => {
		const fields = { message: "hello", message_reviewed: "hello" };

		expect(read(fields).reviewed).toBe(false);
		expect(read({ ...fields, confirm_review: "yes" }).reviewed).toBe(true);
		expect(
			read({ ...fields, message_reviewed: "hullo", confirm_review: "yes" })
				.reviewed,
		).toBe(false);
	});

	it("keeps the technical context only when the person opted in and it is an object", () => {
		const context = JSON.stringify({ deviceCategory: "Desktop browser" });
		const base = { message: "x", from: "/", client_context: context };

		expect(read(base).clientContext).toBeNull();
		expect(
			read({ ...base, include_diagnostics: "yes" }).clientContext,
		).toMatchObject({ route: "/" });
		expect(
			read({ ...base, client_context: "{not json", include_diagnostics: "yes" })
				.clientContext,
		).toBeNull();
	});
});

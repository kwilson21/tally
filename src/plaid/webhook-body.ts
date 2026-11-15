import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Json as JsonValue } from "../json";

// The webhook body, read at the edge (decision 206, #1149). Only the fields the webhook route uses are named. A field of the
// wrong type reads as not sent, as the route's hand checks always did, so one odd field never refuses a whole webhook.

/** A field read as its type, or as not sent when it is any other type. */
const orNotSent = <S extends Schema.Constraint>(schema: S) =>
	Schema.optional(schema).pipe(Schema.catchDecoding(() => Effect.succeedNone));

const WebhookBody = Schema.Struct({
	item_id: orNotSent(Schema.String),
	webhook_type: orNotSent(Schema.String),
	webhook_code: orNotSent(Schema.String),
	error: orNotSent(Schema.Struct({ error_code: orNotSent(Schema.String) })),
	/** On SYNC_UPDATES_AVAILABLE: Plaid's 90-day history is available (#581). */
	historical_update_complete: orNotSent(Schema.Boolean),
});

export type WebhookBody = typeof WebhookBody.Type;

/** What the body's text is: not JSON, JSON that is not an object, or the object's fields as typed values. */
export type WebhookRead =
	| { kind: "not-json" }
	| { kind: "not-object" }
	| { kind: "body"; body: WebhookBody };

export function readWebhookBody(text: string): WebhookRead {
	let parsed: JsonValue;

	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "not-json" };
	}

	// An array is not a webhook, though a Struct would read one as an object with no fields.
	if (Array.isArray(parsed)) return { kind: "not-object" };

	const read = Schema.decodeUnknownResult(WebhookBody)(parsed);

	return Result.isSuccess(read)
		? { kind: "body", body: read.success }
		: { kind: "not-object" };
}

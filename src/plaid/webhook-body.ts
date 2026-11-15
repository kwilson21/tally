import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

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

/** The body's fields as typed values, or null when the parsed JSON is not an object. */
export function readWebhookBody(value: unknown): WebhookBody | null {
	// An array is not a webhook, though a Struct would read one as an object with no fields.
	if (Array.isArray(value)) return null;

	const read = Schema.decodeUnknownResult(WebhookBody)(value);

	return Result.isSuccess(read) ? read.success : null;
}

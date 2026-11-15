import { describe, expect, it } from "vitest";
import type { Json } from "../src/json";
import { readWebhookBody } from "../src/plaid/webhook-body";

// The webhook body is read at the edge (#1149): a field of the wrong type reads as not sent, as the route's hand checks did.

const read = (value: Json) => readWebhookBody(JSON.stringify(value));

describe("readWebhookBody", () => {
	it("gives the fields Plaid sends, as they are", () => {
		const sent = {
			item_id: "item-1",
			webhook_type: "ITEM",
			webhook_code: "ERROR",
			error: { error_code: "ITEM_LOGIN_REQUIRED" },
			historical_update_complete: true,
		};

		expect(read(sent)).toEqual({ kind: "body", body: sent });
	});

	it.each(["not json", "", '{"item_id":'])(
		"says text that is not JSON is not JSON: %j",
		(text) => {
			expect(readWebhookBody(text)).toEqual({ kind: "not-json" });
		},
	);

	it.each([null, [], 5, "text", true])(
		"says JSON that is not an object is not an object: %j",
		(value) => {
			expect(read(value)).toEqual({ kind: "not-object" });
		},
	);

	it("reads a field of the wrong type as not sent", () => {
		expect(
			read({
				item_id: 1,
				webhook_type: ["ITEM"],
				webhook_code: null,
				error: "x",
				historical_update_complete: "true",
			}),
		).toEqual({ kind: "body", body: {} });
	});

	it("reads an error whose code is the wrong type as an error with no code", () => {
		expect(read({ error: { error_code: 1 } })).toEqual({
			kind: "body",
			body: { error: {} },
		});
	});

	it("leaves out what it does not name", () => {
		expect(read({ item_id: "a", extra: { deep: [1] } })).toEqual({
			kind: "body",
			body: { item_id: "a" },
		});
	});
});

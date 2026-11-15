import { describe, expect, it } from "vitest";
import { readWebhookBody } from "../src/plaid/webhook-body";

// The webhook body is read at the edge (#1149): a field of the wrong type reads as not sent, as the route's hand checks did.

describe("readWebhookBody", () => {
	it("gives the fields Plaid sends, as they are", () => {
		expect(
			readWebhookBody({
				item_id: "item-1",
				webhook_type: "ITEM",
				webhook_code: "ERROR",
				error: { error_code: "ITEM_LOGIN_REQUIRED" },
				historical_update_complete: true,
			}),
		).toEqual({
			item_id: "item-1",
			webhook_type: "ITEM",
			webhook_code: "ERROR",
			error: { error_code: "ITEM_LOGIN_REQUIRED" },
			historical_update_complete: true,
		});
	});

	it.each([null, [], 5, "text", true])(
		"refuses a body that is not an object: %j",
		(value) => {
			expect(readWebhookBody(value)).toBeNull();
		},
	);

	it("reads a field of the wrong type as not sent", () => {
		expect(
			readWebhookBody({
				item_id: 1,
				webhook_type: ["ITEM"],
				webhook_code: null,
				error: "x",
				historical_update_complete: "true",
			}),
		).toEqual({});
	});

	it("reads an error whose code is the wrong type as an error with no code", () => {
		expect(readWebhookBody({ error: { error_code: 1 } })).toEqual({
			error: {},
		});
	});

	it("leaves out what it does not name", () => {
		expect(readWebhookBody({ item_id: "a", extra: { deep: [1] } })).toEqual({
			item_id: "a",
		});
	});
});

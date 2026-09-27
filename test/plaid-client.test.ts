import { describe, expect, it, vi } from "vitest";
import { PlaidError, plaidPost } from "../src/plaid/client";

describe("plaidPost", () => {
	it.each([
		[undefined, "https://sandbox.plaid.com/test"],
		["sandbox", "https://sandbox.plaid.com/test"],
		["prodution", "https://sandbox.plaid.com/test"],
		["production", "https://production.plaid.com/test"],
	])("uses the safe base URL for PLAID_ENV=%s", async (plaidEnv, url) => {
		const fetch = vi.fn(async () => Response.json({ ok: true }));
		await plaidPost(
			{
				PLAID_ENV: plaidEnv,
				PLAID_CLIENT_ID: "client",
				PLAID_SECRET: "secret",
			},
			"/test",
			{ value: 1 },
			fetch,
		);
		expect(fetch).toHaveBeenCalledWith(
			url,
			expect.objectContaining({
				body: JSON.stringify({
					value: 1,
					client_id: "client",
					secret: "secret",
				}),
			}),
		);
	});

	it("keeps credentials and response details out of errors", async () => {
		const fetch = vi.fn(async () =>
			Response.json(
				{
					error_type: "API_ERROR",
					error_code: "INTERNAL_SERVER_ERROR",
					request_id: "request-1",
					access_token: "do-not-copy",
				},
				{ status: 500 },
			),
		);
		const error = await plaidPost(
			{ PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" },
			"/test",
			{ public_token: "public-secret" },
			fetch,
		).catch((caught) => caught as PlaidError);
		expect(error).toBeInstanceOf(PlaidError);
		expect(error).toMatchObject({
			error_type: "API_ERROR",
			error_code: "INTERNAL_SERVER_ERROR",
			request_id: "request-1",
		});
		expect(JSON.stringify(error)).not.toMatch(
			/client|secret|public-secret|do-not-copy/,
		);
	});

	it("sanitizes non-JSON error responses", async () => {
		const error = await plaidPost(
			{ PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" },
			"/test",
			{},
			vi.fn(async () => new Response("upstream secret", { status: 500 })),
		).catch((caught) => caught as PlaidError);

		expect(error).toBeInstanceOf(PlaidError);
		expect((error as PlaidError).message).toBe("Plaid request failed");
		expect(JSON.stringify(error)).not.toContain("secret");
	});
});

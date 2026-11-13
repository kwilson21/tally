import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vitest";
import {
	askPlaid,
	createLinkToken,
	exchangePublicToken,
	getInstitutionName,
	getItem,
	type LinkTokenRequest,
	PlaidError,
	type PlaidFailure,
	plaidPost,
	removeItem,
} from "../src/plaid/client";

/** The PlaidError a call rejects with; a call that resolves, or rejects with anything else, fails the test. */
const plaidFailure = (call: Promise<unknown>): Promise<PlaidError> =>
	call.then(
		() => {
			throw new Error("expected the Plaid call to fail");
		},
		(caught: Error) => {
			if (caught instanceof PlaidError) return caught;

			throw caught;
		},
	);

describe("plaidPost", () => {
	it("turns network timeouts into bodyless Plaid errors", async () => {
		let options: RequestInit | undefined;

		const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			options = init;
			throw new DOMException("upstream details", "TimeoutError");
		});

		const error = await plaidFailure(plaidPost({}, "/test", {}, fetch));

		expect(error).toBeInstanceOf(PlaidError);
		expect(error).toMatchObject({
			error_type: undefined,
			error_code: undefined,
			request_id: undefined,
		});
		expect(fetch).toHaveBeenCalledOnce();
		expect(options?.signal).toBeInstanceOf(AbortSignal);
	});

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

		const error = await plaidFailure(
			plaidPost(
				{ PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" },
				"/test",
				{ public_token: "public-secret" },
				fetch,
			),
		);

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
		const error = await plaidFailure(
			plaidPost(
				{ PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" },
				"/test",
				{},
				vi.fn(async () => new Response("upstream secret", { status: 500 })),
			),
		);

		expect(error).toBeInstanceOf(PlaidError);
		expect(error.message).toBe("Plaid request failed");
		expect(JSON.stringify(error)).not.toContain("secret");
	});
});

// The client in Effect (decision 210, step 1): a call fails in one of three named ways, and a good answer is read
// through its schema (decision 206), so a field that is missing or the wrong kind is refused at the edge.

const ENV = { PLAID_CLIENT_ID: "client", PLAID_SECRET: "secret" };

/** A call's answer in a test's words: what Plaid said, or the failure's name, with what a refusal carries. */
const answered = async <A>(call: Effect.Effect<A, PlaidFailure>) => {
	const result = await Effect.runPromise(Effect.result(call));

	if (Result.isSuccess(result)) return { answer: result.success };
	const failure = result.failure;

	return {
		failed: failure._tag,
		said: Predicate.isTagged(failure, "PlaidRefusal")
			? {
					error_type: failure.error_type,
					error_code: failure.error_code,
					request_id: failure.request_id,
				}
			: undefined,
	};
};

type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [field: string]: Json };

const says = (body: Json, status = 200) =>
	vi.fn(async () => Response.json(body, { status }));

describe("askPlaid", () => {
	const Answer = Schema.Struct({ value: Schema.Number });

	const ask = (fetch: typeof globalThis.fetch) =>
		answered(askPlaid(ENV, "/test", {}, Answer, fetch));

	it("gives the answer its schema reads, without the fields it does not name", async () => {
		expect(await ask(says({ value: 3, extra: "left out" }))).toEqual({
			answer: { value: 3 },
		});
	});

	it("could not reach Plaid when the request fails", async () => {
		const fetch = vi.fn(async () => {
			throw new DOMException("upstream details", "TimeoutError");
		});

		expect(await ask(fetch)).toEqual({ failed: "PlaidUnreachable" });
	});

	it("hands the request a signal, so a timeout stops it", async () => {
		let signal: AbortSignal | null | undefined;

		const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			signal = init?.signal;

			return Response.json({ value: 1 });
		});

		await ask(fetch);
		expect(signal).toBeInstanceOf(AbortSignal);
	});

	it("stops reading an answer that stalls, when the call is interrupted", async () => {
		let signal: AbortSignal | null | undefined;

		// Plaid answers, then its body never arrives.
		const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			signal = init?.signal;

			return new Response(new ReadableStream({ start() {} }));
		});

		await Effect.runPromise(
			askPlaid(ENV, "/test", {}, Answer, fetch).pipe(
				Effect.timeoutOption("20 millis"),
			),
		);

		expect(signal?.aborted).toBe(true);
	});

	it.each([
		["text that is not JSON", new Response("upstream secret")],
		["a field of the wrong kind", Response.json({ value: "three" })],
		["a missing field", Response.json({})],
		[
			"an error that is not JSON",
			new Response("upstream secret", { status: 500 }),
		],
	])("could not read %s", async (_story, response) => {
		expect(await ask(vi.fn(async () => response))).toEqual({
			failed: "PlaidUnreadable",
		});
	});

	it("carries what Plaid said when it refuses, and nothing else of the answer", async () => {
		const refused = await ask(
			says(
				{
					error_type: "ITEM_ERROR",
					error_code: "ITEM_NOT_FOUND",
					request_id: "request-1",
					access_token: "do-not-copy",
				},
				400,
			),
		);

		expect(refused).toEqual({
			failed: "PlaidRefusal",
			said: {
				error_type: "ITEM_ERROR",
				error_code: "ITEM_NOT_FOUND",
				request_id: "request-1",
			},
		});
		expect(JSON.stringify(refused)).not.toMatch(/secret|do-not-copy/);
	});

	it("leaves out a refusal's field that is not text", async () => {
		expect(
			await ask(says({ error_code: 7, request_id: "request-2" }, 500)),
		).toEqual({ failed: "PlaidRefusal", said: { request_id: "request-2" } });
	});
});

describe("the client's five calls", () => {
	type Call = () => Effect.Effect<unknown, PlaidFailure>;

	const LINK = {
		user: { client_user_id: "u" },
		client_name: "Tally",
		country_codes: ["US"],
		language: "en",
	} satisfies LinkTokenRequest;

	const LOGIN_ERROR = { error_code: "ITEM_LOGIN_REQUIRED" };

	const READS: [string, Call, unknown][] = [
		[
			"a link token",
			() =>
				createLinkToken(
					ENV,
					LINK,
					says({ link_token: "link-1", expiration: "later" }),
				),
			{ link_token: "link-1" },
		],
		[
			"an exchanged token",
			() =>
				exchangePublicToken(
					ENV,
					"public",
					says({ access_token: "access-1", item_id: "item-1" }),
				),
			{ access_token: "access-1", item_id: "item-1" },
		],
		[
			"an item with no error",
			() =>
				getItem(
					ENV,
					"access",
					says({ item: { institution_id: "ins_1", error: null } }),
				),
			{ item: { institution_id: "ins_1", error: null } },
		],
		[
			"an item with an error",
			() => getItem(ENV, "access", says({ item: { error: LOGIN_ERROR } })),
			{ item: { error: LOGIN_ERROR } },
		],
		[
			"a removed item",
			() => removeItem(ENV, "access", says({ request_id: "request-3" })),
			{ request_id: "request-3" },
		],
		[
			"an institution's name",
			() =>
				getInstitutionName(
					ENV,
					"ins_1",
					says({ institution: { name: "Chase" } }),
				),
			"Chase",
		],
		[
			"no name for an institution without one",
			() => getInstitutionName(ENV, "ins_1", says({})),
			undefined,
		],
	];

	it.each(READS)("reads %s", async (_story, call, answer) => {
		expect(await answered(call())).toEqual({ answer });
	});

	const UNREAD: [string, Call][] = [
		[
			"a link token that is missing",
			() => createLinkToken(ENV, LINK, says({})),
		],
		[
			"an exchange with no access token",
			() => exchangePublicToken(ENV, "public", says({ item_id: "item-1" })),
		],
		[
			"an exchange whose item id is not text",
			() =>
				exchangePublicToken(
					ENV,
					"public",
					says({ access_token: "a", item_id: 5 }),
				),
		],
		["an answer with no item", () => getItem(ENV, "access", says({}))],
		[
			"an institution whose name is not text",
			() =>
				getInstitutionName(ENV, "ins_1", says({ institution: { name: 5 } })),
		],
	];

	it.each(UNREAD)("could not read %s", async (_story, call) => {
		expect(await answered(call())).toEqual({ failed: "PlaidUnreadable" });
	});
});

import { describe, expect, it, vi } from "vitest";
import { deliver, type Mail } from "../src/reconnect/deliver";

// One email to one address (decision 86): Resend first, with the Idempotency-Key the ready email passes (decision 146) and
// no key for the reconnect email, which is unchanged.
const MAIL: Mail = { subject: "Subject", html: "<p>Hi</p>", text: "Hi" };
const timeout = () => AbortSignal.timeout(1000);

const resendOk = () =>
	vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
		return new Response("{}", { status: 200 });
	});

const headersOf = (fetchImpl: ReturnType<typeof resendOk>) =>
	(fetchImpl.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;

describe("deliver: Resend's Idempotency-Key", () => {
	it("sends the reconnect email with no Idempotency-Key", async () => {
		const fetchImpl = resendOk();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key" },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
		);
		expect(outcome.delivered).toBe(true);
		expect(headersOf(fetchImpl)["Idempotency-Key"]).toBeUndefined();
		expect(headersOf(fetchImpl).Authorization).toBe("Bearer test-key");
	});

	it("sends the given key as the Idempotency-Key header to Resend", async () => {
		const fetchImpl = resendOk();
		await deliver(
			{ RESEND_API_KEY: "test-key" },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(headersOf(fetchImpl)["Idempotency-Key"]).toBe("ready-email-abc");
	});

	it("never sends the key to Cloudflare's email, which has no key", async () => {
		const send = vi.fn(async (_message: Record<string, unknown>) => ({}));
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) => {
				return new Response("{}", { status: 500 });
			},
		);
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: { send } },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(true);
		expect(send).toHaveBeenCalledOnce();
		expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toContain(
			"ready-email-abc",
		);
	});
});

// With a key (the ready email, decision 146), a Resend answer that can't say whether the send went through never reaches
// Cloudflare's email: Resend may have accepted it. Without a key (the reconnect email) the fallback is unchanged.
const resendAnswer = (status: number, name?: string) =>
	vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
		return new Response(
			name === undefined ? "{}" : JSON.stringify({ name, statusCode: status }),
			{ status },
		);
	});

const timedOut = () =>
	vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
		throw new DOMException("The operation timed out.", "TimeoutError");
	});

const cloudflareEmail = () => {
	const send = vi.fn(async (_message: Record<string, unknown>) => ({}));
	return { send };
};

describe("deliver: a keyed send never falls back to Cloudflare's email when Resend may have accepted it", () => {
	it("falls back to Cloudflare's email on a 409 invalid_idempotent_request: Resend's docs say the key was used with a different payload, so this body was never sent under it, and the fallback delivers it", async () => {
		const fetchImpl = resendAnswer(409, "invalid_idempotent_request");
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(true);
		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(email.send).toHaveBeenCalledOnce();
	});

	it("does not fall back on any other 409, whatever its name: the answer doesn't say the send didn't go", async () => {
		const fetchImpl = resendAnswer(409, "some_later_conflict");
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(false);
		expect(outcome.kinds).toEqual(["resend 409"]);
		expect(email.send).not.toHaveBeenCalled();
	});

	it("does not fall back on a 409 with no readable name", async () => {
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) =>
				new Response("not json", { status: 409 }),
		);
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(false);
		expect(email.send).not.toHaveBeenCalled();
	});

	it("does not fall back on a network error, which leaves Resend's answer unknown", async () => {
		const fetchImpl = vi.fn(
			async (_url: RequestInfo | URL, _init?: RequestInit) => {
				throw new TypeError("network");
			},
		);
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(false);
		expect(outcome.kinds).toEqual(["resend timeout or error"]);
		expect(email.send).not.toHaveBeenCalled();
	});

	it("does not fall back on a 409 concurrent_idempotent_requests: the first send may still fail, so the try is failed and released", async () => {
		const fetchImpl = resendAnswer(409, "concurrent_idempotent_requests");
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(false);
		expect(outcome.kinds).toEqual(["resend 409"]);
		expect(email.send).not.toHaveBeenCalled();
	});

	it("does not fall back after a timeout: Resend may have accepted the send, so the try is failed with no fallback", async () => {
		const fetchImpl = timedOut();
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(false);
		expect(outcome.kinds).toEqual(["resend timeout or error"]);
		expect(email.send).not.toHaveBeenCalled();
	});

	it("still falls back on a 500, which Resend did not accept", async () => {
		const fetchImpl = resendAnswer(500);
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(true);
		expect(email.send).toHaveBeenCalledOnce();
	});

	it("still falls back on a 4xx other than 409", async () => {
		const fetchImpl = resendAnswer(422, "validation_error");
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
		);
		expect(outcome.delivered).toBe(true);
		expect(email.send).toHaveBeenCalledOnce();
	});
});

describe("deliver: the reconnect email (no key) is unchanged", () => {
	it("falls back to Cloudflare's email after a Resend timeout, as it always has", async () => {
		const fetchImpl = timedOut();
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
		);
		expect(outcome.delivered).toBe(true);
		expect(email.send).toHaveBeenCalledOnce();
	});

	it("falls back on a 409, which means nothing without a key", async () => {
		const fetchImpl = resendAnswer(409, "invalid_idempotent_request");
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
		);
		expect(outcome.delivered).toBe(true);
		expect(email.send).toHaveBeenCalledOnce();
	});
});

// A try Resend may hold (decision 146): with onlyResend, Cloudflare's email is never used, and every answer that isn't a
// success (or no answer) comes back held, so the caller keeps its words and tries again with the same key.
describe("deliver: onlyResend, for a kept try Resend may hold (decision 146)", () => {
	const networkError = () =>
		vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
			throw new TypeError("network");
		});

	it.each([
		["a timeout", () => timedOut()],
		["a network error", () => networkError()],
		[
			"a 409 invalid_idempotent_request",
			() => resendAnswer(409, "invalid_idempotent_request"),
		],
		[
			"a 409 concurrent_idempotent_requests",
			() => resendAnswer(409, "concurrent_idempotent_requests"),
		],
		["a 422", () => resendAnswer(422, "validation_error")],
		["a 429", () => resendAnswer(429, "rate_limit_exceeded")],
		["a 500", () => resendAnswer(500)],
		["a 503", () => resendAnswer(503)],
	])(
		"holds %s, and never sends it through Cloudflare's email",
		async (_label, answer) => {
			const email = cloudflareEmail();
			const outcome = await deliver(
				{ RESEND_API_KEY: "test-key", EMAIL: email },
				"reader@example.com",
				MAIL,
				answer(),
				timeout,
				"ready-email-abc",
				{ onlyResend: true },
			);
			expect(outcome.delivered).toBe(false);
			expect(outcome.held).toBe(true);
			expect(email.send).not.toHaveBeenCalled();
		},
	);

	it("delivers through Resend when it answers with success, and sends the key", async () => {
		const fetchImpl = resendOk();
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ RESEND_API_KEY: "test-key", EMAIL: email },
			"reader@example.com",
			MAIL,
			fetchImpl,
			timeout,
			"ready-email-abc",
			{ onlyResend: true },
		);
		expect(outcome.delivered).toBe(true);
		expect(outcome.held).toBeUndefined();
		expect(headersOf(fetchImpl)["Idempotency-Key"]).toBe("ready-email-abc");
		expect(email.send).not.toHaveBeenCalled();
	});

	it("holds it with no Resend key, since no answer can show it was never sent, and never uses Cloudflare's email", async () => {
		const email = cloudflareEmail();
		const outcome = await deliver(
			{ EMAIL: email },
			"reader@example.com",
			MAIL,
			resendOk(),
			timeout,
			"ready-email-abc",
			{ onlyResend: true },
		);
		expect(outcome.delivered).toBe(false);
		expect(outcome.held).toBe(true);
		expect(outcome.kinds).toEqual(["no provider configured"]);
		expect(email.send).not.toHaveBeenCalled();
	});
});

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
	it("counts a 409 invalid_idempotent_request as delivered: the key was already used, so nothing is sent again or by the fallback", async () => {
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
		expect(outcome).toEqual({ delivered: true, kinds: [] });
		expect(email.send).not.toHaveBeenCalled();
		expect(fetchImpl).toHaveBeenCalledOnce();
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

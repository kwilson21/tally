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

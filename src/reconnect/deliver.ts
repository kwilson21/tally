// One email to one address (decision 86): Resend first, then Cloudflare's email as the fallback. The bank sign-in reminders
// and the ready email (decision 134) both send through it, so they share the sender and the failure kinds.

export const FROM = "Tally <tally@notifs.thesuperhuman.us>";

/** An email's words, the same in HTML and in plain text. */
export type Mail = { subject: string; html: string; text: string };

/** The providers a run sends through: Resend's key and Cloudflare's email binding. Either may be missing. */
export type DeliveryEnv = {
	RESEND_API_KEY?: string;
	EMAIL?: {
		send(message: {
			to: string;
			from: string;
			subject: string;
			html: string;
			text: string;
		}): Promise<unknown>;
	};
};

/**
 * The error name Resend gives an error answer (its body's `name`, such as invalid_idempotent_request), or null when the body
 * has none. A body that can't be read is no name.
 */
async function errorName(response: Response): Promise<string | null> {
	try {
		const body = (await response.json()) as { name?: unknown };
		return typeof body.name === "string" ? body.name : null;
	} catch {
		return null;
	}
}

/**
 * Sends one email to one address. Resend gets it first, with a 10 second timeout; Cloudflare's email only when Resend didn't
 * deliver. `kinds` names each failed attempt by its provider status or error kind (never the address), and is "no provider
 * configured" when neither provider is set up. `idempotencyKey` is sent to Resend only, as its Idempotency-Key header, so
 * a retry of the same email (one Resend already accepted, answered late) is answered from Resend's record and not sent again:
 * Resend keeps a key for 24 hours (its docs, dashboard/emails/idempotency-keys). Cloudflare's email has no such key, so the
 * fallback never carries one.
 *
 * With a key (the ready email, decision 146) Resend may already hold the send, so the fallback is used only when Resend's answer
 * shows this body was never sent under the key (Resend's docs, api-reference/errors and dashboard/emails/idempotency-keys, read
 * 2026-10-21):
 * - a 409 invalid_idempotent_request says the key was used with a different payload, so this body was never sent under it, and
 *   the try is a failed Resend try that falls back like any other;
 * - a 409 concurrent_idempotent_requests (another request with the key is in progress; Resend says it is safe to retry later),
 *   any other 409, and no answer at all (a timeout or a network error) are failed tries with no fallback, and the caller tries
 *   again with the same key;
 * - any other Resend failure falls back, as it does without a key.
 * Without a key (the reconnect email) nothing here changes.
 */
export async function deliver(
	env: DeliveryEnv,
	recipient: string,
	email: Mail,
	fetchImpl: typeof fetch,
	timeoutSignal: (milliseconds: number) => AbortSignal,
	idempotencyKey?: string,
): Promise<{ delivered: boolean; kinds: string[] }> {
	const kinds: string[] = [];
	let delivered = false;
	if (env.RESEND_API_KEY) {
		const response = await fetchImpl("https://api.resend.com/emails", {
			method: "POST",
			signal: timeoutSignal(10_000),
			headers: {
				Authorization: `Bearer ${env.RESEND_API_KEY}`,
				"Content-Type": "application/json",
				...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
			},
			body: JSON.stringify({ from: FROM, to: recipient, ...email }),
		}).catch(() => null);
		delivered = response?.ok ?? false;
		if (!delivered && idempotencyKey) {
			// Resend may already hold this send (decision 146). Only invalid_idempotent_request says this body was never sent
			// under the key, so only it falls back; every other conflict, and no answer, is a failed try with no fallback.
			const conflict =
				response?.status === 409 ? await errorName(response) : null;
			if (
				!response ||
				(response.status === 409 && conflict !== "invalid_idempotent_request")
			)
				return {
					delivered: false,
					kinds: [
						response ? `resend ${response.status}` : "resend timeout or error",
					],
				};
		}
		if (!delivered)
			kinds.push(
				response ? `resend ${response.status}` : "resend timeout or error",
			);
	}
	if (!delivered && env.EMAIL) {
		try {
			await env.EMAIL.send({ to: recipient, from: FROM, ...email });
			delivered = true;
		} catch {
			kinds.push("email fallback error");
		}
	}
	if (!delivered && kinds.length === 0) kinds.push("no provider configured");
	return { delivered, kinds };
}

// One line per run: the counts, and the provider statuses or error kinds that failed. Never an address, a bank or a count of
// transactions.
export function logDeliveries(
	label: string,
	sent: number,
	failed: number,
	failureKinds: Set<string>,
) {
	const failures = failureKinds.size
		? ` (${[...failureKinds].join(", ")})`
		: "";
	const summary = `${label}: ${sent} sent, ${failed} failed${failures}`;
	if (failed) console.error(summary);
	else console.log(summary);
}

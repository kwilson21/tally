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
 * a retry of the same email (one Resend already accepted, answered late) is answered from Resend's record and not sent again.
 * Cloudflare's email has no such key, so the fallback never carries one.
 *
 * With a key (the ready email, decision 146) Resend may already hold the send, so the fallback is not used when Resend's
 * answer can't say it didn't: a 409 invalid_idempotent_request means the key was already used, so the send is delivered
 * (Resend's docs: the key was used on a request with a different payload); a 409 concurrent_idempotent_requests, another
 * 409, or no answer at all (a timeout or a network error) is a failed try with no fallback, and the caller tries again with
 * the same key. Any other Resend failure still falls back, as it does without a key.
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
		if (
			!delivered &&
			idempotencyKey &&
			(!response || response.status === 409)
		) {
			if (
				response &&
				(await errorName(response)) === "invalid_idempotent_request"
			)
				return { delivered: true, kinds: [] };
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

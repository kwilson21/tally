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
 * Sends one email to one address. Resend gets it first, with a 10 second timeout; Cloudflare's email only when Resend didn't
 * deliver. `kinds` names each failed attempt by its provider status or error kind (never the address), and is "no provider
 * configured" when neither provider is set up.
 */
export async function deliver(
	env: DeliveryEnv,
	recipient: string,
	email: Mail,
	fetchImpl: typeof fetch,
	timeoutSignal: (milliseconds: number) => AbortSignal,
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
			},
			body: JSON.stringify({ from: FROM, to: recipient, ...email }),
		}).catch(() => null);
		delivered = response?.ok ?? false;
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

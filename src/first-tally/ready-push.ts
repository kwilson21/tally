// The ready push (decision 149, spec §8.8): one Web Push to each device a person turned notifications on for, once a new family's
// first questions are open and nobody has answered one. It goes to a person only once their page has not checked in for
// PUSH_AWAY_AFTER_MS, and only once: the claim (readyPushedTo) is kept after a success, and the email's own claim (readyEmailedTo)
// stops any push after the email has gone, as does a kept email try (heldReadyEmail), which may already have reached the person.
// A device that answers 404 or 410 is deleted by its row. A device that gives no answer,
// a 429 or a 5xx is transient: when no device answers with a success and some answer is transient, the claim is released and the
// next minute tries again, until the email goes. Any other 4xx is permanent for this push, so the claim is kept and nothing is
// retried every minute. A database error after the claim (the device read, or the release) is a transient failure too, and
// the release is best effort, so a claim is never left stuck by a single failed statement. The minute run calls this before
// runReadyEmail; a failure here never stops the email (src/index.tsx).

import { anyQuestionAnswered, readFirstTally } from "../db/first-tally";
import { type PushEnv, vapidKeys } from "../push/keys";
import { type PushPayload, sendPush } from "../push/web-push";
import { logDeliveries } from "../reconnect/deliver";
import { PUSH_AWAY_AFTER_MS } from "./home-seen";
import {
	addressHashOf,
	claimSql,
	openRead,
	QUESTIONS_PATH,
} from "./ready-email";

/** The push's words: the title and the body the notification shows, and the page it opens (sw.js). */
export const PUSH_PAYLOAD: PushPayload = {
	title: "Tally",
	body: "Your three questions are ready. About three minutes to finish setting up your budget.",
	url: QUESTIONS_PATH,
};

// Not once the email has gone: a person in readyEmailedTo is never pushed (the push is moot after the email).
const NOT_EMAILED_GUARD =
	"\n\t\tAND NOT EXISTS (SELECT 1 FROM json_each(household_settings.value, '$.readyEmailedTo') AS e WHERE e.value = ?1)";

// Not while the email's kept try is stored under the address's hash (decisions 146 and 147). RELEASE_SQL takes the address off
// readyEmailedTo when a try may be held, so the list alone would let a push go after Resend may have accepted the email.
const NOT_KEPT_GUARD =
	"\n\t\tAND json_type(household_settings.value, '$.heldReadyEmail.\"' || ?2 || '\"') IS NULL";

/** Claims one person for the push: the email's guards, plus not yet emailed and no kept try. ?1 is the address, ?2 its hash. */
export const PUSH_CLAIM_SQL = claimSql(
	"$.readyPushedTo",
	PUSH_AWAY_AFTER_MS,
	NOT_EMAILED_GUARD + NOT_KEPT_GUARD,
);

/**
 * Takes one person back off readyPushedTo, so the next minute tries again. Only that list: RELEASE_SQL would also rewrite the kept
 * email's try under the same address hash, and so wipe it (decisions 146 and 147).
 */
export const PUSH_RELEASE_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value, '$.readyPushedTo',
		json((SELECT json_group_array(e.value) FROM json_each(household_settings.value, '$.readyPushedTo') AS e WHERE e.value <> ?1)))
	WHERE key = 'first_tally'`;

/** The people with at least one device, once each (the join keeps a removed person's devices out, as they are deleted). */
const PEOPLE_SQL = `SELECT DISTINCT s.member_email AS email FROM push_subscriptions s
	JOIN household_members m ON m.email = s.member_email ORDER BY s.member_email`;

const DEVICES_SQL =
	"SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE member_email = ? ORDER BY id";

type Device = { id: number; endpoint: string; p256dh: string; auth: string };

/** How one device's answer counts (decision 149). */
type Answer = "sent" | "gone" | "permanent" | "transient";

function answerOf(status: number | null): Answer {
	if (status === null) return "transient";
	if (status >= 200 && status < 300) return "sent";
	if (status === 404 || status === 410) return "gone";
	if (status === 429 || status >= 500) return "transient";
	return "permanent";
}

/**
 * The ready push, run each minute and by the 10:00 backstop. It does nothing without the VAPID keys (the demo, or no secrets),
 * reading nothing. Otherwise it reads the record once and the gate once: a question answered, or the questions not open, ends it.
 * Then, for each person with a device, the claim (PUSH_CLAIM_SQL) decides whether they go on, and each of their devices is sent
 * to inside its own try, so a failure there counts as that device failing and never stops the others. Only the counts are
 * logged, under "ready push", and only when someone was claimed.
 */
export async function runReadyPush(
	env: PushEnv & { DB: D1Database; DEMO?: string },
	options: {
		fetchImpl?: typeof fetch;
		timeoutSignal?: () => AbortSignal;
		now?: () => number;
	} = {},
) {
	const keys = await vapidKeys(env);
	if (!keys) return;
	const record = await readFirstTally(env.DB);
	if (anyQuestionAnswered(record) || (await openRead(env.DB, record)) === null)
		return;
	const { results: people } = await env.DB.prepare(PEOPLE_SQL).all<{
		email: string;
	}>();
	const nowMs = (options.now ?? Date.now)();
	let claimedCount = 0;
	let sentCount = 0;
	let failedCount = 0;
	const failureKinds = new Set<string>();
	for (const { email } of people) {
		const claim = await env.DB.prepare(PUSH_CLAIM_SQL)
			.bind(email, await addressHashOf(email))
			.run();
		// No row changed: already pushed (an earlier run, or one still going), emailed, removed, or still on a first-week page.
		if (!claim.meta.changes) continue;
		claimedCount += 1;
		let devices: Device[] = [];
		let delivered = 0;
		let transient = false;
		try {
			devices = (await env.DB.prepare(DEVICES_SQL).bind(email).all<Device>())
				.results;
		} catch {
			// A device read that fails right after the claim is one transient failure, so the claim is released below.
			failedCount += 1;
			failureKinds.add("push error");
			transient = true;
		}
		for (const device of devices) {
			try {
				const { status } = await sendPush(
					{
						endpoint: device.endpoint,
						p256dh: device.p256dh,
						auth: device.auth,
					},
					PUSH_PAYLOAD,
					keys,
					{
						fetchImpl: options.fetchImpl,
						timeoutSignal: options.timeoutSignal,
						nowSec: Math.floor(nowMs / 1000),
					},
				);
				const answer = answerOf(status);
				// A device that is gone is deleted by its row, as read: a subscription made since (another row) is kept.
				if (answer === "gone")
					await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?")
						.bind(device.id)
						.run();
				if (answer === "sent") {
					sentCount += 1;
					delivered += 1;
					continue;
				}
				failedCount += 1;
				failureKinds.add(status === null ? "push no answer" : `push ${status}`);
				if (answer === "transient") transient = true;
			} catch {
				// A throw (a database error, say) is a failed device, and transient, so the claim is not left stuck.
				failedCount += 1;
				failureKinds.add("push error");
				transient = true;
			}
		}
		if (delivered === 0 && transient) {
			// Best effort: if the release itself fails, the claim stays, the failure is counted, and the next person still goes.
			try {
				await env.DB.prepare(PUSH_RELEASE_SQL).bind(email).run();
			} catch {
				failedCount += 1;
				failureKinds.add("push error");
			}
		}
	}
	if (claimedCount > 0)
		logDeliveries("ready push", sentCount, failedCount, failureKinds);
}

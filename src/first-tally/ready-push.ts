// The ready push (decision 149, spec §8.8): one Web Push to each device a person turned notifications on for, once a new family's
// first questions are open and nobody has answered one. It goes to a person only once their page has not checked in for
// PUSH_AWAY_AFTER_MS, and only once: the claim (readyPushedTo) is kept after a success, and the email's own claim (readyEmailedTo)
// stops any push after the email has gone, as does a kept email try (heldReadyEmail), which may already have reached the person.
// A device that answers 404 or 410 is deleted by its row. A device that gives no answer, a 429 or a 5xx is transient: when no
// device answers with a success and some answer is transient, the claim is released and the next minute tries again, until
// the email goes. Any other 4xx is permanent for this push, so the claim is kept and nothing is retried every minute.
// Every device is read in one query before any claim, so a failed read claims nobody (the run throws, the minute run logs it,
// and the next minute tries again). The gate (the record, the banks and the sort count, as the email reads it) is read again
// before each person's claim, so a bank linked meanwhile or a question answered stops the run there (decision 149).
// Each person is claimed just before their devices are sent to, and a device whose send throws counts as failed without
// stopping the others. When a device takes the push, the time is stored (readyPushedAt), and the ready email waits
// EMAIL_AFTER_PUSH_MS from it (ready-email.tsx). The release is best effort: if it fails, that one person keeps their one
// claim and gets no push, but the email still goes at ten minutes, since its own claim (readyEmailedTo) does not depend on
// this one. The minute run calls this before runReadyEmail; a failure here never stops the email (src/index.tsx).

import { readFirstTally } from "../db/first-tally";
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
	title: "Set up your budget",
	body: "Your transactions are sorted. Three quick questions, about three minutes.",
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

/**
 * Stores the time a push reached one of a person's devices, under the address's hash (readyPushedAt, decision 149). ?1 is the hash.
 * The time is SQLite's own clock, as the email's guard reads it (ready-email.tsx), so the two never disagree.
 */
export const PUSH_STAMP_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value, '$.readyPushedAt."' || ?1 || '"', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	WHERE key = 'first_tally'`;

/**
 * Every device with the person it belongs to, read before any claim (the join keeps a device with no member row out, and a
 * removed person's devices are deleted with them).
 */
const DEVICES_SQL = `SELECT s.id, s.member_email AS email, s.endpoint, s.p256dh, s.auth FROM push_subscriptions s
	JOIN household_members m ON m.email = s.member_email ORDER BY s.member_email, s.id`;

type Device = {
	id: number;
	email: string;
	endpoint: string;
	p256dh: string;
	auth: string;
};

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
 * The gate as the email reads it (openRead on a record read now): true while the questions are open to the push, false once a
 * question is answered or the gate closes (a bank's history still loading, a sort waiting, the last bank removed).
 */
async function gateOpen(db: D1Database): Promise<boolean> {
	return (await openRead(db, await readFirstTally(db))) !== null;
}

/**
 * The ready push, run each minute and by the 10:00 backstop. It does nothing without the VAPID keys (the demo, or no secrets),
 * reading nothing. Otherwise it reads the gate: a question answered, or the questions not open, ends it. It then reads every
 * device once, before any claim. For each person with a device, the gate is read again and a closed gate ends the run there, so
 * nobody after it is claimed or pushed (decision 149). Then the claim (PUSH_CLAIM_SQL) decides whether that person goes on, and
 * each of their devices is sent to inside its own try, so a failure there counts as that device failing and never stops the
 * others. Only the counts are logged, under "ready push", and only when someone was claimed.
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
	if (!(await gateOpen(env.DB))) return;
	// The one read of the devices, before any claim: a failure here throws, and no one is claimed.
	const { results } = await env.DB.prepare(DEVICES_SQL).all<Device>();
	const byPerson = new Map<string, Device[]>();
	for (const device of results) {
		const list = byPerson.get(device.email) ?? [];
		list.push(device);
		byPerson.set(device.email, list);
	}
	const nowMs = (options.now ?? Date.now)();
	let claimedCount = 0;
	let sentCount = 0;
	let failedCount = 0;
	const failureKinds = new Set<string>();
	for (const [email, devices] of byPerson) {
		// The gate, read again before this person's claim: a bank linked or a question answered since the last person ends the run.
		if (!(await gateOpen(env.DB))) break;
		const hash = await addressHashOf(email);
		const claim = await env.DB.prepare(PUSH_CLAIM_SQL).bind(email, hash).run();
		// No row changed: already pushed (an earlier run, or one still going), emailed, removed, or still on a first-week page.
		if (!claim.meta.changes) continue;
		claimedCount += 1;
		let delivered = 0;
		let transient = false;
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
		if (delivered > 0) {
			// The email waits EMAIL_AFTER_PUSH_MS from this push (decision 149). If the time can't be stored, that is counted, and the
			// email goes at ten minutes as before.
			try {
				await env.DB.prepare(PUSH_STAMP_SQL).bind(hash).run();
			} catch {
				failedCount += 1;
				failureKinds.add("push error");
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

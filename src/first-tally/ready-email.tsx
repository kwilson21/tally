// The ready email (P140, decision 134, decision 146, spec §8.8): one email to each person on the household list once a new
// family's first questions are open, while pay, bills and budgets are all undrawn. The minute run sends it (the 10:00 run
// checks too, as a backstop). It goes to a person only once their page has not checked in for EMAIL_AWAY_AFTER_MS: someone
// still on Home's setup (while it refreshes) or the questions page sees the questions there instead. An address is claimed in the record's
// readyEmailedTo before its email goes, and released unless the email is delivered. A try Resend may already have accepted (no
// answer, or a 409 other than invalid_idempotent_request, deliver.ts) is released too, keeping its words, and the next try sends
// those same words under the same key, so it is never sent twice; the questions staying open is what lets it be tried again.
// It is drawn like the bank sign-in email (src/reconnect/email.tsx).
import {
	anyQuestionAnswered,
	QUESTION_STROKES,
	readFirstTally,
} from "../db/first-tally";
import {
	type DeliveryEnv,
	deliver,
	logDeliveries,
	type Mail,
} from "../reconnect/deliver";
import { reconnectRecipients } from "../reconnect/reminders";
import { andList } from "./budgets";
import { questionsOpen, readGateInputs } from "./gate";
import { EMAIL_AWAY_AFTER_MS } from "./home-seen";

const SUBJECT = "Three questions to finish setting up";
const NEXT =
	"Now check three things: your pay, your bills and your budgets. About three minutes.";
const BUTTON = "Finish setting up";
const LINK = "https://tally.thesuperhuman.us/first-page";
const FOOT = "Tally sends this once, to everyone in your family who uses it.";

// The same test in SQL. json_type is NULL only when the key is absent (a null value reads 'null'), as the rest of the code tests it.
const QUESTIONS_UNDRAWN_SQL = QUESTION_STROKES.map(
	(stroke) =>
		`json_type(household_settings.value, '$.strokes.${stroke}') IS NULL`,
).join(" AND ");

// The transactions the connected banks sent: Plaid's own. A split part or a manual entry has no Plaid id, so it is left out.
const SORTED_SQL = `SELECT COUNT(*) AS total FROM transactions t
	JOIN accounts a ON a.id = t.account_id
	JOIN plaid_items p ON p.id = a.plaid_item_id
	WHERE p.disconnected_at IS NULL AND t.plaid_transaction_id IS NOT NULL`;

// Claims an address before its email is sent. It changes no row when the address is in the list already, so a second claim
// of one address (an earlier run, or one still going) sends nothing. It changes no row either once a question is answered,
// or when the address is no longer one the email goes to (removed, or not seen in 90 days: reconnectRecipients' rule), or
// when its person checked in on a first-week page within EMAIL_AWAY_AFTER_MS (home_seen_at): they are still there, so a
// later minute tries them. A refused address is skipped; runReadyEmail reads the gate again before the next one, so a
// question answered meanwhile ends it.
export const CLAIM_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value, '$.readyEmailedTo',
		json_insert(COALESCE(json_extract(household_settings.value, '$.readyEmailedTo'), json('[]')), '$[#]', ?1))
	WHERE key = 'first_tally' AND ${QUESTIONS_UNDRAWN_SQL} AND NOT EXISTS (
		SELECT 1 FROM json_each(household_settings.value, '$.readyEmailedTo') AS e WHERE e.value = ?1)
		AND EXISTS (SELECT 1 FROM household_members m WHERE m.email = ?1 AND m.removed_at IS NULL AND m.last_seen_at >= datetime('now','-90 days')
			AND (m.home_seen_at IS NULL OR m.home_seen_at < datetime('now', '-${EMAIL_AWAY_AFTER_MS / 1000} seconds')))`;

// Takes an address back off the list when neither provider delivered it, so the next minute's run tries it again. ?2 is the
// address's hash and ?3 the read line a try Resend may hold keeps (decision 146), or NULL when none is kept: a definite failure
// keeps no words, so it removes any line kept before (json_patch takes a null away), and the next try uses fresh ones.
const RELEASE_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value,
		'$.readyEmailedTo', json((SELECT json_group_array(e.value) FROM json_each(household_settings.value, '$.readyEmailedTo') AS e WHERE e.value <> ?1)),
		'$.heldReadyEmail', json(json_patch(COALESCE(json_extract(household_settings.value, '$.heldReadyEmail'), '{}'), json_object(?2, ?3))))
	WHERE key = 'first_tally'`;

// The read line kept for an address (RELEASE_SQL), or null when none is.
const HELD_SQL = `SELECT json_extract(value, '$.heldReadyEmail') AS held FROM household_settings WHERE key = 'first_tally'`;

/**
 * The Idempotency-Key the ready email carries to Resend (decision 146): "ready-email-" and the SHA-256 in hex of the JSON of
 * the lower-cased address, the subject, the HTML and the text, so 76 characters, under Resend's 256. Every try at one address
 * with the same words sends the same key. Resend keeps a key for 24 hours (its docs, dashboard/emails/idempotency-keys), so a
 * try that came after one Resend had already accepted (answered past deliver's timeout) gets Resend's answer for that send and
 * nothing is sent twice. A retry whose words changed has a new key, so it is a new email.
 */
export async function readyEmailKey(
	address: string,
	mail: Mail,
): Promise<string> {
	return `ready-email-${await sha256Hex(JSON.stringify([address.toLowerCase(), mail.subject, mail.html, mail.text]))}`;
}

/** SHA-256 in hex of a text. */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** The hash of the lower-cased address: the key a kept read line is stored under, so the address itself is never stored. */
const addressHashOf = (address: string) => sha256Hex(address.toLowerCase());

/**
 * The read line kept for an address whose last try Resend may hold (RELEASE_SQL), or null when none is kept. The next try
 * sends these words, so that try is the same email under the same key (decision 146).
 */
async function heldLineOf(db: D1Database, address: string) {
	const row = await db.prepare(HELD_SQL).first<{ held: string | null }>();
	if (!row?.held) return null;
	const line = (JSON.parse(row.held) as Record<string, unknown>)[
		await addressHashOf(address)
	];
	return typeof line === "string" ? line : null;
}

/**
 * The read line: the connected banks by name, each once and in link order, joined with "and"; more than three names give the
 * count of banks instead. Then the transactions they sent, with thousands commas, or nothing when there are none.
 */
export function readLine(banks: { name: string }[], total: number): string {
	const names = [...new Set(banks.map((bank) => bank.name))];
	const from = names.length > 3 ? `${banks.length} banks` : andList(names);
	let sorted = "";
	if (total === 1) sorted = " and sorted 1 transaction";
	else if (total > 1)
		sorted = ` and sorted all ${total.toLocaleString("en-US")} transactions`;
	return `Tally has read your last 90 days from ${from}${sorted}.`;
}

function ReadyEmail({ read }: { read: string }) {
	return (
		<html lang="en">
			<body style="margin:0;background:#fbf8f2;color:#0e0e0e;font-family:Arial,sans-serif">
				<main style="max-width:560px;margin:0 auto;padding:32px 24px">
					<p style="font-size:14px;color:#4a4a4a">Tally</p>
					<h1 style="font-family:Georgia,serif;font-size:28px">{SUBJECT}</h1>
					<p>{read}</p>
					<p>{NEXT}</p>
					<p style="margin-top:28px">
						<a
							href={LINK}
							style="display:inline-block;background:#ae5534;color:#ffffff;padding:14px 20px;border-radius:12px;text-decoration:none"
						>
							{BUTTON}
						</a>
					</p>
					<p style="font-size:13px;color:#4a4a4a;margin-top:32px">{FOOT}</p>
				</main>
			</body>
		</html>
	);
}

export function renderReadyEmail(read: string): Mail {
	const text = `${SUBJECT}\n\n${read}\n\n${NEXT}\n\n${BUTTON}: ${LINK}\n\n${FOOT}`;
	// The component has no async parts, so its JSX node renders synchronously to a string.
	const html = (<ReadyEmail read={read} />).toString();
	if (typeof html !== "string")
		throw new Error("The ready email must render without async parts");
	return { subject: SUBJECT, html, text };
}

/**
 * The email's words as the gate reads them now, or null while the questions are not open to the email: every connected
 * bank's history is in, nothing waits for Jev, and no question is answered. The facts are the ones the gate reads (gate.ts),
 * read again at each address's turn so a change during the run is seen.
 */
async function currentRead(env: { DB: D1Database }): Promise<string | null> {
	const record = await readFirstTally(env.DB);
	if (anyQuestionAnswered(record)) return null;
	const { banks, waiting } = await readGateInputs(env.DB);
	if (
		!questionsOpen({
			strokeOneDay: record?.strokes.bank ?? null,
			banks,
			waiting,
		})
	)
		return null;
	const total =
		(await env.DB.prepare(SORTED_SQL).first<{ total: number }>())?.total ?? 0;
	return readLine(banks, total);
}

/**
 * The ready email, sent by the minute run (decision 146; the 10:00 run is the backstop). It sends only while the first week's
 * questions are open (questionsOpen, the gate) and pay, bills and budgets are all undrawn, so a household set up before this
 * shipped, or one that has answered, costs one read and gets none. It goes to each household address not yet in
 * readyEmailedTo, whatever the bank sign-in switch says, and only to a person whose page has not checked in for
 * EMAIL_AWAY_AFTER_MS (CLAIM_SQL): a person still there is tried on a later minute. The demo never sends. Before each address
 * the gate is read again and the email is built from that read, so its words are true when it goes. A closed gate (a question
 * answered, a bank linked with its history still loading, the last bank removed, a sort waiting) ends the run there, and
 * nothing more is sent. Another bank linked or removed changes the words from then on. An address no longer a member is
 * skipped on its own (CLAIM_SQL). A try Resend may hold keeps its words for the address's next try, which sends them again
 * under the same key (decision 146). The log line is written only when an address was claimed, so a quiet minute logs nothing.
 */
export async function runReadyEmail(
	env: DeliveryEnv & { DB: D1Database; DEMO?: string },
	fetchImpl: typeof fetch = fetch,
	timeoutSignal: (milliseconds: number) => AbortSignal = AbortSignal.timeout,
) {
	if (env.DEMO === "true") return;
	// The minute's first read: a family whose questions are answered (or set up before this shipped), or with no stroke one day
	// (which questionsOpen needs, so nothing could be sent), stops here. Everyone else costs one read each minute.
	const record = await readFirstTally(env.DB);
	if (anyQuestionAnswered(record) || (record?.strokes.bank ?? null) === null)
		return;
	if ((await currentRead(env)) === null) return;
	const recipients = (await reconnectRecipients(env.DB)).results;
	let claimedCount = 0;
	let sentCount = 0;
	let failedCount = 0;
	const failureKinds = new Set<string>();
	for (const { email: recipient } of recipients) {
		const read = await currentRead(env);
		if (read === null) break;
		const claim = await env.DB.prepare(CLAIM_SQL).bind(recipient).run();
		// No row changed: the address was reached already (an earlier run, or one still going), it is no longer a member, or
		// its person is still on a first-week page. Each is skipped. A question answered after the read above is caught by
		// the next address's read.
		if (!claim.meta.changes) continue;
		claimedCount += 1;
		// The words a try Resend held kept for this address, or this read's (decision 146). One Mail for this address: its words
		// give the key and are the body Resend is sent.
		const words = (await heldLineOf(env.DB, recipient)) ?? read;
		const mail = renderReadyEmail(words);
		const outcome = await deliver(
			env,
			recipient,
			mail,
			fetchImpl,
			timeoutSignal,
			await readyEmailKey(recipient, mail),
		);
		if (outcome.delivered) {
			sentCount += 1;
			continue;
		}
		failedCount += 1;
		for (const kind of outcome.kinds) failureKinds.add(kind);
		// A send Resend may hold keeps these words for the next try; any other failure keeps none (RELEASE_SQL).
		await env.DB.prepare(RELEASE_SQL)
			.bind(
				recipient,
				await addressHashOf(recipient),
				outcome.held ? words : null,
			)
			.run();
	}
	if (claimedCount > 0)
		logDeliveries("ready email", sentCount, failedCount, failureKinds);
}

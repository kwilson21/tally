// The ready email (P140, decision 134, decision 146, spec §8.8): one email to each person on the household list once a new
// family's first questions are open, while pay, bills and budgets are all undrawn. The minute run sends it (the 10:00 run
// checks too, as a backstop). It goes to a person only once their page has not checked in for EMAIL_AWAY_AFTER_MS: someone
// still on Home's setup (while it refreshes) or the questions page sees the questions there instead. An address is claimed in
// the record's readyEmailedTo before its email goes, and released unless the email is delivered. A try Resend may already
// have accepted (no answer, or any answer but a success, deliver.ts) is kept: the whole email it tried (subject, HTML and
// text) and the UTC time of that first try are stored, and every later try sends that same stored email through Resend
// only, under the same key, until Resend answers, for up to HELD_DROP_AFTER_MS. The stored email is never built again, so a
// deploy that changes the words cannot change the key. After that the address stays reached and nothing more is sent
// (decisions 146 and 147). It is drawn like the bank sign-in email (src/reconnect/email.tsx).
import {
	anyQuestionAnswered,
	type FirstTally,
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
/** The first week's questions page: the ready email's button and the ready push's link both open it (decision 149). */
export const QUESTIONS_PATH = "/first-page";
const LINK = `https://tally.thesuperhuman.us${QUESTIONS_PATH}`;
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

/**
 * The claim for one address, in SQL (shared with the ready push, decision 149). `listPath` is the record's list the address
 * joins: readyEmailedTo for the email, readyPushedTo for the push. ?1 is the address. It changes no row when the address is in
 * that list already, so a second claim of one address (an earlier run, or one still going) sends nothing. It changes no row
 * either once a question is answered, or when the address is no longer one the send goes to (removed, or not seen in 90 days:
 * reconnectRecipients' rule), or when its person checked in on a first-week page within `awayMs` (home_seen_at): they are
 * still there, so a later minute tries them. `extraGuard` adds one more condition after the list's, with ?1 as the address.
 */
export function claimSql(
	listPath: string,
	awayMs: number,
	extraGuard = "",
): string {
	return `UPDATE household_settings
	SET value = json_set(household_settings.value, '${listPath}',
		json_insert(COALESCE(json_extract(household_settings.value, '${listPath}'), json('[]')), '$[#]', ?1))
	WHERE key = 'first_tally' AND ${QUESTIONS_UNDRAWN_SQL} AND NOT EXISTS (
		SELECT 1 FROM json_each(household_settings.value, '${listPath}') AS e WHERE e.value = ?1)${extraGuard}
		AND EXISTS (SELECT 1 FROM household_members m WHERE m.email = ?1 AND m.removed_at IS NULL AND m.last_seen_at >= datetime('now','-90 days')
			AND (m.home_seen_at IS NULL OR m.home_seen_at < datetime('now', '-${awayMs / 1000} seconds')))`;
}

// Claims an address before its email is sent. A refused address is skipped; runReadyEmail reads the gate again before the next
// one, so a question answered meanwhile ends it (claimSql has the rest).
export const CLAIM_SQL = claimSql("$.readyEmailedTo", EMAIL_AWAY_AFTER_MS);

// Takes an address back off the list when neither provider delivered it, so the next minute's run tries it again. ?2 is the
// address's hash and ?3 the kept try as JSON ({"mail", "at"}, decision 146), or NULL when none is kept: a definite failure
// keeps no try, so it removes any kept before (json_patch takes a null away), and the next try uses fresh words. The
// address's old entry is removed first, so the new one replaces it whole: a patch alone would merge it into an entry the
// merged code kept as its read line ({"line", "at"}), and leave that line behind.
const RELEASE_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value,
		'$.readyEmailedTo', json((SELECT json_group_array(e.value) FROM json_each(household_settings.value, '$.readyEmailedTo') AS e WHERE e.value <> ?1)),
		'$.heldReadyEmail', json(json_patch(json_remove(COALESCE(json_extract(household_settings.value, '$.heldReadyEmail'), '{}'), '$."' || ?2 || '"'), json_object(?2, json(?3)))))
	WHERE key = 'first_tally'`;

// Removes one address's kept try and leaves the address on the list: the kept try was delivered, or is too old to try again.
const DROP_HELD_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value,
		'$.heldReadyEmail', json(json_patch(COALESCE(json_extract(household_settings.value, '$.heldReadyEmail'), '{}'), json_object(?1, NULL))))
	WHERE key = 'first_tally'`;

// The kept tries (heldReadyEmail), read whole: the minute run picks one address's out of them.
const HELD_SQL = `SELECT json_extract(value, '$.heldReadyEmail') AS held FROM household_settings WHERE key = 'first_tally'`;

// Turns one legacy kept try into the whole email its line builds, with its own time. ?1 is the address's hash and ?2 the kept
// try as JSON ({"mail", "at"}). Only an entry that is still a line when the write lands changes, so a release that replaced
// it meanwhile is never overwritten, and the other paths of the record are left as they are.
const KEEP_LEGACY_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value, '$.heldReadyEmail."' || ?1 || '"', json(?2))
	WHERE key = 'first_tally'
		AND json_type(household_settings.value, '$.heldReadyEmail."' || ?1 || '".line') = 'text'
		AND json_type(household_settings.value, '$.heldReadyEmail."' || ?1 || '".mail') IS NULL`;

/**
 * A try Resend may hold, kept for its address (decision 146): the whole email it tried, and the UTC time of the first such try
 * as `YYYY-MM-DDTHH:MM:SSZ`, which later held tries never change.
 */
type KeptTry = { mail: Mail; at: string };

/**
 * A kept try the merged code stored before the whole email was kept (c5577a5): its read line and the time of its first try,
 * and no email. keepLegacyTries turns each into the email its line builds.
 */
type LegacyTry = { line: string; at: string };

/** The kept tries still stored as only a read line, by the address's hash (none in a record that keeps whole emails). */
function legacyTriesOf(record: FirstTally | null): [string, LegacyTry][] {
	const tries: [string, LegacyTry][] = [];
	for (const [hash, entry] of Object.entries(record?.heldReadyEmail ?? {})) {
		const { mail, line, at } = entry as {
			mail?: unknown;
			line?: unknown;
			at?: unknown;
		};
		if (
			mail === undefined &&
			typeof line === "string" &&
			typeof at === "string"
		)
			tries.push([hash, { line, at }]);
	}
	return tries;
}

/**
 * Turns each legacy kept try into the whole email its line builds, with its own time, in one write (decision 147). It runs at
 * the start of each minute that reads the record, whether or not that address can be claimed this minute, so each kept try's
 * words, and so its key, are fixed from then on. A record with no such entry writes nothing.
 */
async function keepLegacyTries(
	db: D1Database,
	record: FirstTally | null,
): Promise<void> {
	const tries = legacyTriesOf(record);
	if (tries.length === 0) return;
	await db.batch(
		tries.map(([hash, { line, at }]) =>
			db
				.prepare(KEEP_LEGACY_SQL)
				.bind(hash, JSON.stringify({ mail: renderReadyEmail(line), at })),
		),
	);
}

/**
 * A kept try older than this is not tried again: Resend keeps an Idempotency-Key for 24 hours (its docs, dashboard/emails/
 * idempotency-keys), so a later try could be a new send. The hour's margin keeps a try inside that window.
 */
const HELD_DROP_AFTER_MS = 23 * 3_600_000;

/** The log kind a kept try dropped for being too old is counted under (never the address). */
const HELD_OVER_A_DAY = "held over a day";

/** A time as the kept tries write it: UTC to the second, `YYYY-MM-DDTHH:MM:SSZ`. */
const isoSecond = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

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

/**
 * The hash of the lower-cased address: the key a kept try is stored under in heldReadyEmail, so the address itself is never
 * stored. The ready push reads it too, to see whether a kept try may already have reached the address (decision 149).
 */
export const addressHashOf = (address: string) =>
	sha256Hex(address.toLowerCase());

/**
 * The kept try for an address (RELEASE_SQL), or null when none is kept. The next try sends its stored email, so that try is
 * the same email under the same key (decision 146). keepLegacyTries has already turned an entry the merged code kept as only
 * its read line (c5577a5) into its email, at the start of this minute; a line-only entry still here is read as the email its
 * line builds, the same way. An entry that is neither a stored email nor a line, with a time, is no kept try.
 */
async function keptTryOf(
	db: D1Database,
	address: string,
): Promise<KeptTry | null> {
	const row = await db.prepare(HELD_SQL).first<{ held: string | null }>();
	if (!row?.held) return null;
	const entry = (JSON.parse(row.held) as Record<string, unknown>)[
		await addressHashOf(address)
	];
	if (typeof entry !== "object" || entry === null) return null;
	const { mail, line, at } = entry as Record<string, unknown>;
	if (typeof at !== "string") return null;
	if (mail === undefined && typeof line === "string")
		return { mail: renderReadyEmail(line), at };
	if (typeof mail !== "object" || mail === null) return null;
	const { subject, html, text } = mail as Record<string, unknown>;
	return typeof subject === "string" &&
		typeof html === "string" &&
		typeof text === "string"
		? { mail: { subject, html, text }, at }
		: null;
}

/**
 * True when a kept try is too old to send again (HELD_DROP_AFTER_MS), or its time can't be read: a try whose age is unknown
 * is dropped, since it may be past Resend's key window.
 */
function keptTooOld(kept: KeptTry, nowMs: number): boolean {
	const since = Date.parse(kept.at);
	return !Number.isFinite(since) || nowMs - since > HELD_DROP_AFTER_MS;
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
export async function openRead(
	db: D1Database,
	record: FirstTally | null,
): Promise<string | null> {
	if (anyQuestionAnswered(record)) return null;
	const { banks, waiting } = await readGateInputs(db);
	if (
		!questionsOpen({
			strokeOneDay: record?.strokes.bank ?? null,
			banks,
			waiting,
		})
	)
		return null;
	const total =
		(await db.prepare(SORTED_SQL).first<{ total: number }>())?.total ?? 0;
	return readLine(banks, total);
}

/** openRead on a record read now, for each address's turn. */
async function currentRead(env: { DB: D1Database }): Promise<string | null> {
	return openRead(env.DB, await readFirstTally(env.DB));
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
 * skipped on its own (CLAIM_SQL). A try Resend may hold keeps its whole email and the time of that first try (KeptTry). The
 * next try sends that stored email again under the same key, through Resend only, until Resend answers (decisions 146 and
 * 147). A kept try 23 hours old is dropped, and the address stays reached. The log line is written only when an address was
 * claimed, so a quiet minute logs nothing.
 */
export async function runReadyEmail(
	env: DeliveryEnv & { DB: D1Database; DEMO?: string },
	fetchImpl: typeof fetch = fetch,
	timeoutSignal: (milliseconds: number) => AbortSignal = AbortSignal.timeout,
) {
	if (env.DEMO === "true") return;
	// The minute's first read. A kept try stored as only its read line (c5577a5) becomes its whole email first, so its words are
	// fixed whatever this minute does (decision 147); a record without one writes nothing here.
	const record = await readFirstTally(env.DB);
	await keepLegacyTries(env.DB, record);
	// A family whose questions are answered (or set up before this shipped), or with no stroke one day (which questionsOpen
	// needs, so nothing could be sent), stops here. Everyone else costs one read each minute.
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
		const hash = await addressHashOf(recipient);
		// The kept try for this address, if a try Resend may hold kept one (decision 146). Its stored email is sent again, through
		// Resend only; otherwise this read's email goes out, and a failure that Resend may not hold keeps nothing (RELEASE_SQL).
		const kept = await keptTryOf(env.DB, recipient);
		if (kept && keptTooOld(kept, Date.now())) {
			// Resend keeps the key for a day, so a later try could be a new send: nothing more is sent. The address stays reached.
			await env.DB.prepare(DROP_HELD_SQL).bind(hash).run();
			failedCount += 1;
			failureKinds.add(HELD_OVER_A_DAY);
			continue;
		}
		// One Mail for this address: its words give the key and are the body Resend is sent. A kept try's stored Mail is that
		// email, so its key never changes with the code.
		const mail = kept ? kept.mail : renderReadyEmail(read);
		const outcome = await deliver(
			env,
			recipient,
			mail,
			fetchImpl,
			timeoutSignal,
			await readyEmailKey(recipient, mail),
			{ onlyResend: kept !== null },
		);
		if (outcome.delivered) {
			sentCount += 1;
			// Reached: its kept try is no longer needed.
			if (kept) await env.DB.prepare(DROP_HELD_SQL).bind(hash).run();
			continue;
		}
		failedCount += 1;
		for (const kind of outcome.kinds) failureKinds.add(kind);
		// A try Resend may hold keeps its whole email and the time of its first such try, which a later held try never moves. Any
		// other failure keeps nothing.
		const keep = outcome.held
			? JSON.stringify({ mail, at: kept?.at ?? isoSecond(Date.now()) })
			: null;
		await env.DB.prepare(RELEASE_SQL).bind(recipient, hash, keep).run();
	}
	if (claimedCount > 0)
		logDeliveries("ready email", sentCount, failedCount, failureKinds);
}

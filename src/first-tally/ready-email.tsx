// The ready email (P140, decision 134, decision 146, spec §8.8): one email to each person on the household list once a new
// family's first questions are open, while pay, bills and budgets are all undrawn. The minute run sends it (the 10:00 run
// checks too, as a backstop). It goes to a person only once their page has not checked in for EMAIL_AWAY_AFTER_MS: someone
// still on setup's reading screen (while it refreshes) or the questions page sees the questions there instead. An address is
// claimed in the record's readyEmailedTo before its email goes, and the claim stores that email (its whole subject, HTML and
// text, as a kept try with tried: false), and the claim's time (readyClaimedAt), in the same write (decision 223). The claim is
// released unless the email is delivered. A claim cut off after its write (a deploy, a crash, an eviction) is found after
// READY_LEASE_MINUTES (ten minutes): the next run sends the stored email again, through Resend only, under the same key. A try Resend may
// already have accepted (no answer, or any answer but a success, deliver.ts) is kept: the whole email it tried and the UTC time of
// that first try are stored, and every later try sends that same stored email through Resend only, under the same key, until
// Resend answers, for up to HELD_DROP_AFTER_MS. The stored email is never built again, so a deploy that changes the words cannot
// change the key. After that the address stays reached and nothing more is sent (decisions 146, 147 and 223). It is drawn like
// the bank sign-in email (src/reconnect/email.tsx).
import {
	anyQuestionAnswered,
	type FirstTally,
	QUESTION_STROKES,
	readFirstTally,
} from "../db/first-tally";
import { READY_LEASE_MINUTES } from "../machines/ready-claim";
import {
	type DeliveryEnv,
	deliver,
	logDeliveries,
	type Mail,
} from "../reconnect/deliver";
import { reconnectRecipients } from "../reconnect/reminders";
import { andList } from "./budgets";
import { questionsOpen, readGateInputs } from "./gate";
import { EMAIL_AFTER_PUSH_MS, EMAIL_AWAY_AFTER_MS } from "./home-seen";

const SUBJECT = "Three questions to finish setting up";

const NEXT =
	"Now check three things: your pay, your bills and your budgets. About three minutes.";

const BUTTON = "Finish setting up";

/**
 * Setup (decision 148): the ready email's button and the ready push's link open it, and it moves on to the questions once
 * they're open (setup's route, src/routes/setup.tsx).
 */
export const SETUP_PATH = "/setup";
const LINK = `https://tally.thesuperhuman.us${SETUP_PATH}`;
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
 * `extraSet` writes more paths in the same statement, as `, '<path>', <value>, ...` (the push's stamp, decision 149; the
 * email's kept try and its stamp, decision 223), so the list and those paths change together or not at all.
 */
export function claimSql(
	listPath: string,
	awayMs: number,
	extraGuard = "",
	extraSet = "",
): string {
	return `UPDATE household_settings
	SET value = json_set(household_settings.value, '${listPath}',
		json_insert(COALESCE(json_extract(household_settings.value, '${listPath}'), json('[]')), '$[#]', ?1)${extraSet})
	WHERE key = 'first_tally' AND ${QUESTIONS_UNDRAWN_SQL} AND NOT EXISTS (
		SELECT 1 FROM json_each(household_settings.value, '${listPath}') AS e WHERE e.value = ?1)${extraGuard}
		AND EXISTS (SELECT 1 FROM household_members m WHERE m.email = ?1 AND m.removed_at IS NULL AND m.last_seen_at >= datetime('now','-90 days')
			AND (m.home_seen_at IS NULL OR m.home_seen_at < datetime('now', '-${awayMs / 1000} seconds')))`;
}

// Not within EMAIL_AFTER_PUSH_MS of a ready push (decision 149). readyPushedAt is written when the push claims the person (holding the
// email while the push is in flight), moved to the delivery's time when a device takes it, and removed when none does; if that removal
// fails, it keeps the claim's time and the email waits 8 minutes from the claim. So the push is seen first, and the email waits for the
// person to come back or answer. ?2 is the address's hash, the key readyPushedAt stores the time under.
const PUSH_WAIT_GUARD = `\n\t\tAND (json_type(household_settings.value, '$.readyPushedAt."' || ?2 || '"') IS NULL
		OR datetime(json_extract(household_settings.value, '$.readyPushedAt."' || ?2 || '"')) <= datetime('now', '-${EMAIL_AFTER_PUSH_MS / 1000} seconds'))`;

// The email's claim writes its kept try and its stamp with the list (decision 223): ?2 is the address's hash and ?3 the kept try the
// claim stores, as JSON ({"mail", "at", "tried": false}). An entry already kept for the hash stays as it is (COALESCE), so an earlier
// try's email and time are never replaced. The stamp is SQLite's UTC time, as the push's is (PUSH_STAMP_SQL).
const CLAIM_KEPT = `, '$.heldReadyEmail."' || ?2 || '"', json(COALESCE(json_extract(household_settings.value, '$.heldReadyEmail."' || ?2 || '"'), json(?3))),
		'$.readyClaimedAt."' || ?2 || '"', strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`;

// Claims an address before its email is sent. ?1 is the address, ?2 its hash and ?3 the kept try the claim stores. A refused
// address is skipped; runReadyEmail reads the gate again before the next one, so a question answered meanwhile ends it (claimSql
// has the rest).
export const CLAIM_SQL = claimSql(
	"$.readyEmailedTo",
	EMAIL_AWAY_AFTER_MS,
	PUSH_WAIT_GUARD,
	CLAIM_KEPT,
);

// Takes an address back off the list when neither provider delivered it, so the next minute's run tries it again, and removes
// its claim's stamp (readyClaimedAt). ?2 is the address's hash and ?3 the kept try as JSON ({"mail", "at"}, decision 146), or NULL
// when none is kept: a definite failure keeps no try, so it removes any kept before (json_patch takes a null away), and the next
// try uses fresh words. The address's old entry is removed first, so the new one replaces it whole: a patch alone would merge it
// into an entry the merged code kept as its read line ({"line", "at"}), and leave that line behind.
const RELEASE_SQL = `UPDATE household_settings
	SET value = json_remove(json_set(household_settings.value,
		'$.readyEmailedTo', json((SELECT json_group_array(e.value) FROM json_each(household_settings.value, '$.readyEmailedTo') AS e WHERE e.value <> ?1)),
		'$.heldReadyEmail', json(json_patch(json_remove(COALESCE(json_extract(household_settings.value, '$.heldReadyEmail'), '{}'), '$."' || ?2 || '"'), json_object(?2, json(?3))))),
		'$.readyClaimedAt."' || ?2 || '"')
	WHERE key = 'first_tally'`;

// Removes one address's kept try and its claim's stamp, and leaves the address on the list: the kept try was delivered, or is too
// old to try again. ?1 is the address's hash.
const DROP_HELD_SQL = `UPDATE household_settings
	SET value = json_remove(json_set(household_settings.value,
		'$.heldReadyEmail', json(json_patch(COALESCE(json_extract(household_settings.value, '$.heldReadyEmail'), '{}'), json_object(?1, NULL)))),
		'$.readyClaimedAt."' || ?1 || '"')
	WHERE key = 'first_tally'`;

// Recovers a cut-off claim (decision 223): re-stamps it, and only while the address is still listed, a kept try is stored, and the
// stamp is at least the lease old. Of several runs at once only the one that changes the row (meta.changes) sends. ?1 is the
// address's hash and ?2 the address. A stamp that is missing reads NULL, so a claim with no stamp is never recovered.
const RECOVER_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value, '$.readyClaimedAt."' || ?1 || '"', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
	WHERE key = 'first_tally'
		AND EXISTS (SELECT 1 FROM json_each(household_settings.value, '$.readyEmailedTo') AS e WHERE e.value = ?2)
		AND json_type(household_settings.value, '$.heldReadyEmail."' || ?1 || '"') IS NOT NULL
		AND datetime(json_extract(household_settings.value, '$.readyClaimedAt."' || ?1 || '"')) <= datetime('now', '-${READY_LEASE_MINUTES * 60} seconds')`;

// The kept tries (heldReadyEmail), read whole: the minute run picks one address's out of them.
const HELD_SQL = `SELECT json_extract(value, '$.heldReadyEmail') AS held FROM household_settings WHERE key = 'first_tally'`;

// Turns one legacy kept try into the whole email its line builds, with its own time. ?1 is the address's hash and ?2 the kept
// try as JSON ({"mail", "at"}). Only an entry that is still a line when the write lands changes, so a release that replaced
// it meanwhile is never overwritten, and the other paths of the record are left as they are.
const UPGRADE_LEGACY_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value, '$.heldReadyEmail."' || ?1 || '"', json(?2))
	WHERE key = 'first_tally'
		AND json_type(household_settings.value, '$.heldReadyEmail."' || ?1 || '".line') = 'text'
		AND json_type(household_settings.value, '$.heldReadyEmail."' || ?1 || '".mail') IS NULL`;

/**
 * A try Resend may hold, kept for its address (decision 146): the whole email it tried, and the UTC time of the first such try
 * as `YYYY-MM-DDTHH:MM:SSZ`, which later held tries never change. `tried: false` marks an email a claim stored before any run
 * sent it (decision 223): its first try is a fresh try, so Cloudflare's email may still be used. Without it, the email may
 * already have reached Resend, and only Resend is tried.
 */
type KeptTry = { mail: Mail; at: string; tried?: false };

/**
 * A kept try the merged code stored before the whole email was kept (c5577a5): its read line and the time of its first try,
 * and no email. upgradeLegacyTries turns each into the email its line builds.
 */
type LegacyTry = { line: string; at: string };

/** A stored kept try's fields, each checked where it is read: a whole email, a read line, a time and the fresh mark. */
type StoredTry = {
	mail?: unknown;
	line?: unknown;
	at?: unknown;
	tried?: unknown;
};

/** The fields of a stored email, each checked where it is read. */
type StoredMail = { subject?: unknown; html?: unknown; text?: unknown };

/** True for a stored JSON object (not null). Its fields are checked where they are read. */
const isStored = <Stored extends object>(value: unknown): value is Stored =>
	typeof value === "object" && value !== null;

/** True for a value stored as text. */
const isText = (value: unknown): value is string => typeof value === "string";

/** The kept tries still stored as only a read line, by the address's hash (none in a record that keeps whole emails). */
function legacyTriesOf(record: FirstTally | null): [string, LegacyTry][] {
	const tries: [string, LegacyTry][] = [];

	for (const [hash, entry] of Object.entries(record?.heldReadyEmail ?? {})) {
		// The legacy line is not in the record's type, so the entry is read as the fields it may hold, each checked here.
		const { mail, line, at }: StoredTry = entry;

		if (mail === undefined && isText(line) && isText(at))
			tries.push([hash, { line, at }]);
	}

	return tries;
}

/**
 * Turns each legacy kept try into the whole email its line builds, with its own time, in one write (decision 147). It runs at
 * the start of each minute that reads the record, whether or not that address can be claimed this minute, so each kept try's
 * words, and so its key, are fixed from then on. A record with no such entry writes nothing.
 */
async function upgradeLegacyTries(
	db: D1Database,
	record: FirstTally | null,
): Promise<void> {
	const tries = legacyTriesOf(record);

	if (tries.length === 0) return;
	await db.batch(
		tries.map(([hash, { line, at }]) =>
			db
				.prepare(UPGRADE_LEGACY_SQL)
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
 * the same email under the same key (decision 146). upgradeLegacyTries has already turned an entry the merged code kept as only
 * its read line (c5577a5) into its email, at the start of this minute; a line-only entry still here is read as the email its
 * line builds, the same way. An entry that is neither a stored email nor a line, with a time, is no kept try.
 */
async function keptTryOf(
	db: D1Database,
	address: string,
): Promise<KeptTry | null> {
	const row = await db.prepare(HELD_SQL).first<{ held: string | null }>();

	if (!row?.held) return null;

	const held: unknown = JSON.parse(row.held);

	const entry = isStored<{ [hash: string]: StoredTry | undefined }>(held)
		? held[await addressHashOf(address)]
		: undefined;

	if (!isStored<StoredTry>(entry)) return null;

	const { mail, line, at, tried } = entry;

	if (!isText(at)) return null;

	// Only a claim's own entry is marked fresh: the email was stored and no run has sent it.
	const fresh = tried === false;

	if (mail === undefined && isText(line))
		return { mail: renderReadyEmail(line), at, ...(fresh && { tried: false }) };

	if (!isStored<StoredMail>(mail)) return null;

	const { subject, html, text } = mail;

	return isText(subject) && isText(html) && isText(text)
		? {
				mail: { subject, html, text },
				at,
				...(fresh && { tried: false }),
			}
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

	if (!isText(html))
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

/** What one run counts: the addresses it claimed or recovered, the sends that were delivered and that failed, and the kinds. */
type RunCounts = {
	claimed: number;
	sent: number;
	failed: number;
	kinds: Set<string>;
};

/** What every send in one run is made with: the providers, the fetch and its timeout, and the run's counts. */
type Sending = {
	env: DeliveryEnv & { DB: D1Database };
	fetchImpl: typeof fetch;
	timeoutSignal: (milliseconds: number) => AbortSignal;
	counts: RunCounts;
};

/**
 * One email's outcome for its address (decisions 146 and 223). A delivered email drops its kept try and stamp. A held try keeps
 * its email and its first time, without the fresh mark, so later tries send it through Resend only. A definite failure keeps
 * nothing. `onlyResend` is set for a recovered claim (its earlier run may have sent) and for a kept try that may have reached
 * Resend already; a fresh claim's email may fall back to Cloudflare's, as any first try does.
 */
async function sendKept(
	sending: Sending,
	recipient: string,
	hash: string,
	kept: KeptTry,
	onlyResend: boolean,
) {
	const { env, fetchImpl, timeoutSignal, counts } = sending;

	if (keptTooOld(kept, Date.now())) {
		// Resend keeps the key for a day, so a later try could be a new send: nothing more is sent. The address stays reached.
		await env.DB.prepare(DROP_HELD_SQL).bind(hash).run();
		counts.failed += 1;
		counts.kinds.add(HELD_OVER_A_DAY);

		return;
	}

	// The email's words give the key. The stored email is the one every try sends, so its key never changes with the code.
	const outcome = await deliver(
		env,
		recipient,
		kept.mail,
		fetchImpl,
		timeoutSignal,
		await readyEmailKey(recipient, kept.mail),
		{ onlyResend },
	);

	if (outcome.delivered) {
		counts.sent += 1;
		await env.DB.prepare(DROP_HELD_SQL).bind(hash).run();

		return;
	}

	counts.failed += 1;

	for (const kind of outcome.kinds) counts.kinds.add(kind);

	// A try Resend may hold keeps its whole email and the time of its first such try, which a later held try never moves. Any
	// other failure keeps nothing.
	const keep = outcome.held
		? JSON.stringify({ mail: kept.mail, at: kept.at })
		: null;

	await env.DB.prepare(RELEASE_SQL).bind(recipient, hash, keep).run();
}

/**
 * Sends the stored email of an address whose claim was cut off (decision 223), if this run is the one that re-stamps it. Returns
 * false when the address is not in that state (it is not listed, it has no kept try, its stamp is under the lease, or another
 * run re-stamped it first): the address then goes on to the claim, which changes no row for a listed address. Returns true when
 * this run took the address, so no fresh email is built for it. A stored email that can't be read is dropped, not sent.
 */
async function recoverCutOff(
	sending: Sending,
	recipient: string,
	hash: string,
): Promise<boolean> {
	const { env, counts } = sending;
	const won = await env.DB.prepare(RECOVER_SQL).bind(hash, recipient).run();

	if (!won.meta.changes) return false;
	counts.claimed += 1;

	const kept = await keptTryOf(env.DB, recipient);

	if (kept === null) {
		await env.DB.prepare(DROP_HELD_SQL).bind(hash).run();
		counts.failed += 1;
		counts.kinds.add(HELD_OVER_A_DAY);

		return true;
	}

	// Always Resend only: the cut-off run may already have sent this email, under this key.
	await sendKept(sending, recipient, hash, kept, true);

	return true;
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
 * skipped on its own (CLAIM_SQL). Each address's claim stores the email it will send, with the time of the claim (decision 223).
 * A claim cut off after that write is found by a later run once its stamp is READY_LEASE_MINUTES (ten minutes) old, and that stored email
 * is sent again, through Resend only, under its key, if this run is the one that takes it; the record is read again first, so
 * a closed gate sends nothing. A try Resend may hold keeps its whole email and the time of that first try (KeptTry). The
 * next try sends that stored email again under the same key, through Resend only, until Resend answers (decisions 146 and
 * 147). A kept try 23 hours old is dropped, and the address stays reached. The log line is written only when an address was
 * claimed or recovered, so a quiet minute logs nothing.
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
	await upgradeLegacyTries(env.DB, record);

	// A family whose questions are answered (or set up before this shipped), or with no stroke one day (which questionsOpen
	// needs, so nothing could be sent), stops here. Everyone else costs one read each minute.
	if (anyQuestionAnswered(record) || (record?.strokes.bank ?? null) === null)
		return;

	if ((await currentRead(env)) === null) return;
	const recipients = (await reconnectRecipients(env.DB)).results;

	const counts: RunCounts = {
		claimed: 0,
		sent: 0,
		failed: 0,
		kinds: new Set<string>(),
	};

	const sending: Sending = { env, fetchImpl, timeoutSignal, counts };

	for (const { email: recipient } of recipients) {
		const read = await currentRead(env);

		if (read === null) break;
		const hash = await addressHashOf(recipient);

		// A claim cut off earlier is sent again first (decision 223); an address it does not take is claimed below.
		if (await recoverCutOff(sending, recipient, hash)) continue;

		// The email is built before the claim, so the claim stores the words it will send, with the time of the claim.
		const built = renderReadyEmail(read);

		const claim = await env.DB.prepare(CLAIM_SQL)
			.bind(
				recipient,
				hash,
				JSON.stringify({
					mail: built,
					at: isoSecond(Date.now()),
					tried: false,
				}),
			)
			.run();

		// No row changed: the address was reached already (an earlier run, or one still going), it is no longer a member, its
		// person is still on a first-week page, or their readyPushedAt stamp is under EMAIL_AFTER_PUSH_MS old (a push in flight, one
		// that reached a device, or a claim whose stamp could not be removed). Each is skipped.
		// A question answered after the read above is caught by the next address's read.
		if (!claim.meta.changes) continue;
		counts.claimed += 1;

		// The stored try after the claim: this address's kept try if one was kept before, else the email this claim stored. A stored
		// entry that can't be read is replaced by this claim's email, as a first try was always sent (no entry was kept to match).
		const kept: KeptTry = (await keptTryOf(env.DB, recipient)) ?? {
			mail: built,
			at: isoSecond(Date.now()),
			tried: false,
		};

		// A kept try from before this claim (no fresh mark) may already have reached Resend: only Resend is tried for it.
		await sendKept(sending, recipient, hash, kept, kept.tried !== false);
	}

	if (counts.claimed > 0)
		logDeliveries("ready email", counts.sent, counts.failed, counts.kinds);
}

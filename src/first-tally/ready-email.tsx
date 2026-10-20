// The ready email (P140, decision 134, spec §8.8): one email to each person on the household list, sent by the 10:00 UTC run on
// the first morning a new family's first questions are open, while pay, bills and budgets are all undrawn. An address is
// claimed in the record's readyEmailedTo before its email goes, and released if neither provider delivers, so it is tried
// again the next morning and no one gets it twice. It is drawn like the bank sign-in email (src/reconnect/email.tsx).
import { householdToday } from "../dates";
import { type FirstTally, readFirstTally } from "../db/first-tally";
import {
	type DeliveryEnv,
	deliver,
	logDeliveries,
	type Mail,
} from "../reconnect/deliver";
import { reconnectRecipients } from "../reconnect/reminders";
import { andList } from "./budgets";
import { questionsOpen, readGateInputs } from "./gate";

const SUBJECT = "Three questions to finish setting up";
const NEXT =
	"Now check three things: your pay, your bills and your budgets. About three minutes.";
const BUTTON = "Finish setting up";
const LINK = "https://tally.thesuperhuman.us/first-page";
const FOOT = "Tally sends this once, to everyone in your family who uses it.";

// The three questions' strokes: once any is drawn, the questions have been answered and nothing is sent.
const QUESTION_STROKES = ["pay", "bills", "budgets"] as const;

// True once any of the questions is drawn. A stroke is drawn when its key is present, so a migrated record's null counts.
function answeredQuestion(record: FirstTally | null): boolean {
	return QUESTION_STROKES.some(
		(stroke) => record?.strokes[stroke] !== undefined,
	);
}

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
// or when the address is no longer one the email goes to (removed, or not seen in 90 days: reconnectRecipients' rule). A
// refused address is skipped; runReadyEmail reads the gate again before the next one, so a question answered meanwhile ends it.
export const CLAIM_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value, '$.readyEmailedTo',
		json_insert(COALESCE(json_extract(household_settings.value, '$.readyEmailedTo'), json('[]')), '$[#]', ?1))
	WHERE key = 'first_tally' AND ${QUESTIONS_UNDRAWN_SQL} AND NOT EXISTS (
		SELECT 1 FROM json_each(household_settings.value, '$.readyEmailedTo') AS e WHERE e.value = ?1)
		AND EXISTS (SELECT 1 FROM household_members m WHERE m.email = ?1 AND m.removed_at IS NULL AND m.last_seen_at >= datetime('now','-90 days'))`;

// Takes an address back off the list when neither provider delivered it, so the next morning's run tries it again.
const RELEASE_SQL = `UPDATE household_settings
	SET value = json_set(household_settings.value, '$.readyEmailedTo',
		json((SELECT json_group_array(e.value) FROM json_each(household_settings.value, '$.readyEmailedTo') AS e WHERE e.value <> ?1)))
	WHERE key = 'first_tally'`;

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
 * The email's words as the gate reads them now, or null while the questions are not open to the email: stroke one's day has
 * passed, every connected bank's history is in, nothing waits for Jev, and no question is answered. The facts are the ones
 * the gate reads (gate.ts), read again at each address's turn so a change during the run is seen.
 */
async function currentRead(
	env: { DB: D1Database },
	today: string,
): Promise<string | null> {
	const record = await readFirstTally(env.DB);
	if (answeredQuestion(record)) return null;
	const { banks, waiting } = await readGateInputs(env.DB);
	if (
		!questionsOpen({
			today,
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
 * The 10:00 run's ready email. It sends only while the first week's questions are open (questionsOpen, the gate) and pay,
 * bills and budgets are all undrawn, so a household set up before this shipped, or one that has answered, gets none. It
 * goes to each household address not yet in readyEmailedTo, whatever the bank sign-in switch says. The demo never sends.
 * Before each address the gate is read again and the email is built from that read, so its words are true when it goes.
 * A closed gate (a question answered, a bank linked with its history still loading, the last bank removed, a sort waiting)
 * ends the run there, and nothing more is sent. Another bank linked or removed changes the words from then on. An address
 * no longer a member is skipped on its own (CLAIM_SQL).
 */
export async function runReadyEmail(
	env: DeliveryEnv & { DB: D1Database; DEMO?: string },
	fetchImpl: typeof fetch = fetch,
	now: Date = new Date(),
	timeoutSignal: (milliseconds: number) => AbortSignal = AbortSignal.timeout,
) {
	if (env.DEMO === "true") return;
	const today = await householdToday(env.DB, now);
	if ((await currentRead(env, today)) === null) return;
	const recipients = (await reconnectRecipients(env.DB)).results;
	let sentCount = 0;
	let failedCount = 0;
	const failureKinds = new Set<string>();
	for (const { email: recipient } of recipients) {
		const read = await currentRead(env, today);
		if (read === null) break;
		const claim = await env.DB.prepare(CLAIM_SQL).bind(recipient).run();
		// No row changed: the address was reached already (an earlier run, or one still going), or it is no longer a member.
		// Either way it is skipped. A question answered after the read above is caught by the next address's read.
		if (!claim.meta.changes) continue;
		const outcome = await deliver(
			env,
			recipient,
			renderReadyEmail(read),
			fetchImpl,
			timeoutSignal,
		);
		if (outcome.delivered) {
			sentCount += 1;
			continue;
		}
		failedCount += 1;
		for (const kind of outcome.kinds) failureKinds.add(kind);
		await env.DB.prepare(RELEASE_SQL).bind(recipient).run();
	}
	logDeliveries("ready email", sentCount, failedCount, failureKinds);
}

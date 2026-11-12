import * as Effect from "effect/Effect";
import { Hono } from "hono";
import { runWith } from "../db/database";
import { decideFeedback } from "../db/feedback-saves";
import {
	diagnosticsEnabled,
	normalizeFeedbackContext,
} from "../feedback/diagnostics";
import {
	FEEDBACK_FEELINGS,
	FEEDBACK_TYPES,
	readFeedbackForm,
	safePath,
} from "../feedback/form";
import {
	sanitizeFeedbackMessage,
	sanitizeFeedbackRoute,
} from "../feedback/privacy";
import { sendFeedback } from "../rules/feedback";
import type { Refusal } from "../rules/terms";
import { FeedbackForm, type FeedbackValues } from "../views/feedback-form";
import { Layout } from "../views/layout";

type FeedbackEnv = Env & {
	FEEDBACK_GITHUB_TOKEN?: string;
	FEEDBACK_DIAGNOSTICS_ENABLED?: string;
	APP_VERSION?: string;
};

type App = { Bindings: FeedbackEnv; Variables: { actor: string } };

export const feedback = new Hono<App>();

type FeedbackRow = {
	id: number;
	type: string;
	feeling: string;
	message: string;
	page: string;
	device: string;
	client_context: string | null;
	attempts: number;
};

const TYPES = new Set<string>(FEEDBACK_TYPES);
const FEELINGS = new Set<string>(FEEDBACK_FEELINGS);

const FEEDBACK_LIMIT_COOKIE = "__Host-tally-feedback-limit";

const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function feedbackLimitId(cookieHeader: string | undefined) {
	const pair = cookieHeader
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${FEEDBACK_LIMIT_COOKIE}=`));

	const token = pair?.slice(FEEDBACK_LIMIT_COOKIE.length + 1) ?? "";

	return UUID.test(token) ? token : null;
}

function setFeedbackLimitCookie(response: Response, token: string) {
	const headers = new Headers(response.headers);
	headers.append(
		"Set-Cookie",
		`${FEEDBACK_LIMIT_COOKIE}=${token}; Max-Age=3600; Path=/; Secure; HttpOnly; SameSite=Strict`,
	);

	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function view(
	values: FeedbackValues,
	demo: boolean,
	options: {
		error?: string;
		diagnosticsEnabled?: boolean;
		reviewRequired?: boolean;
		/** The address asked for ?keys, so the keys sheet opens over this page (decision 118). */
		keys?: boolean;
	} = {},
) {
	return (
		<Layout
			title="Send feedback · Tally"
			active="feedback"
			demo={demo}
			currentPath={`/feedback?return_to=${encodeURIComponent(values.returnTo ?? values.from)}${options.keys ? "&keys" : ""}`}
			modules={["/js/feedback-privacy.js"]}
		>
			<FeedbackForm
				values={values}
				demo={demo}
				error={options.error}
				diagnosticsEnabled={options.diagnosticsEnabled}
				reviewRequired={options.reviewRequired}
			/>
		</Layout>
	);
}

feedback.get("/feedback", async (c) => {
	let source: string | undefined;
	const referer = c.req.header("referer");

	// A Referer that is not a URL is no page to come from, so the form comes from Home.
	if (referer && URL.canParse(referer)) {
		const url = new URL(referer);

		if (url.origin === new URL(c.req.url).origin)
			// On /feedback itself, the sidebar's current item carries the page the form came from.
			source =
				url.pathname === "/feedback"
					? c.req.query("return_to")
					: `${url.pathname}${url.search}`;
	}

	const from = source ? sanitizeFeedbackRoute(source) : "/";
	const returnTo = source ? safePath(source, true) : "/";
	const existingToken = feedbackLimitId(c.req.header("cookie"));

	const response = c.html(
		view(
			{ type: "Bug", feeling: "Okay", message: "", from, returnTo },
			c.env.DEMO === "true",
			{
				diagnosticsEnabled: diagnosticsEnabled(c.env),
				keys: new URL(c.req.url).searchParams.has("keys"),
			},
		),
	);

	if (c.env.DEMO === "true") return response;

	return existingToken
		? response
		: setFeedbackLimitCookie(await response, crypto.randomUUID());
});

feedback.post("/feedback", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const sent = readFeedbackForm(await c.req.formData());
	const diagnosticsOn = diagnosticsEnabled(c.env);

	const values = {
		type: sent.type,
		feeling: sent.feeling,
		message: sent.message,
		from: sent.from,
		returnTo: sent.returnTo,
	};

	/** The form again with a refusal's sentence. `review` asks the person to confirm the cleaned message before sending. */
	const refused = (
		refusal: Refusal,
		status: 200 | 400 | 422 | 429,
		review = false,
	) =>
		Effect.succeed({
			saved: null,
			page: c.html(
				view(values, false, {
					error: refusal.say,
					diagnosticsEnabled: diagnosticsOn,
					reviewRequired: review,
				}),
				status,
			),
		});

	const answer = await runWith(
		c.env.DB,
		decideFeedback(sendFeedback, {
			sender: feedbackLimitId(c.req.header("cookie")),
			// The time of the send, as SQLite writes it in UTC (decision 195: the rule and the save read no clock).
			now: new Date().toISOString().slice(0, 19).replace("T", " "),
			type: sent.type,
			feeling: sent.feeling,
			message: sent.message,
			typedLength: sent.typedLength,
			reviewed: sent.reviewed,
			page: sent.from,
			device: sent.device,
			clientContext:
				diagnosticsOn && sent.clientContext
					? JSON.stringify(sent.clientContext)
					: null,
			appVersion: c.env.APP_VERSION || null,
		}).pipe(
			Effect.map(({ saved }) => ({ saved: saved ?? null, page: null })),
			Effect.catchTags({
				// An expired form gets a new id, so the same message can be sent again.
				FormExpired: (refusal) =>
					refused(refusal, 400, true).pipe(
						Effect.map(({ page }) => ({
							saved: null,
							page: Promise.resolve(page).then((response) =>
								setFeedbackLimitCookie(response, crypto.randomUUID()),
							),
						})),
					),
				MessageTooLong: (refusal) => refused(refusal, 422),
				NoMessage: (refusal) => refused(refusal, 422),
				// An unreviewed message is the form's next step, so it is not an error status.
				NotReviewed: (refusal) => refused(refusal, 200, true),
				TooManyThisHour: (refusal) => refused(refusal, 429),
			}),
		),
	);

	if (answer.page) return answer.page;
	const saved = answer.saved;

	if (c.env.FEEDBACK_GITHUB_TOKEN) {
		const row = await c.env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
			.bind(saved)
			.first<FeedbackRow>();

		if (row)
			c.executionCtx.waitUntil(
				fileFeedbackIssue(c.env.DB, c.env.FEEDBACK_GITHUB_TOKEN, row).catch(
					() => {},
				),
			);
	}

	const back = new URL(values.returnTo, "http://tally.invalid");
	back.searchParams.set("sent", "feedback");

	return c.redirect(`${back.pathname}${back.search}${back.hash}`, 303);
});

class FilingError extends Error {
	constructor(readonly status: number) {
		super(`Feedback GitHub request failed (${status})`);
	}
}

// Not filed, not given up (5 attempts), and not claimed in the last 10 minutes: a claim
// older than that belongs to a run that was cut off, so the row is ready again.
const READY =
	"github_issue_number IS NULL AND attempts < 5 AND (filing_at IS NULL OR filing_at <= datetime('now', '-10 minutes'))";

/** The longest run of backticks, counted without spreading, so any length of text is safe. */
function longestBacktickRun(text: string): number {
	let longest = 0;

	for (const run of text.match(/`+/g) ?? [])
		longest = Math.max(longest, run.length);

	return longest;
}

/** A code span the text can't close: more backticks than its longest run, padded with spaces. */
function codeSpan(text: string): string {
	const longest = longestBacktickRun(text);
	const ticks = "`".repeat(longest + 1);

	return `${ticks} ${text} ${ticks}`;
}

/** A fence longer than any run of backticks in the text, so the text can't close it. */
function fenced(text: string): string {
	const longest = longestBacktickRun(text);
	const fence = "`".repeat(Math.max(3, longest + 1));

	return `${fence}\n${text}\n${fence}`;
}

function diagnosticLines(item: FeedbackRow) {
	const lines: string[] = [];

	if (item.client_context) {
		try {
			const context = normalizeFeedbackContext(
				JSON.parse(item.client_context),
				item.page,
			);

			if (context)
				lines.push(
					`Route: ${codeSpan(context.route)}\nDevice category: ${context.deviceCategory}${context.errorName ? `\nRecent error category: ${context.errorName}` : ""}`,
				);
		} catch {
			// Ignore malformed or legacy context; never file its raw contents.
		}
	}

	return lines;
}

export async function fileFeedbackIssue(
	db: D1Database,
	token: string,
	row: FeedbackRow,
	fetchImpl: typeof fetch = fetch,
) {
	const item = row;

	const claim = await db
		.prepare(
			`UPDATE feedback SET filing_at = CURRENT_TIMESTAMP, attempts = attempts + 1 WHERE id = ? AND ${READY}`,
		)
		.bind(item.id)
		.run();

	if (claim.meta.changes === 0) return;
	const safeMessage = sanitizeFeedbackMessage(item.message).trim();
	const safeType = TYPES.has(item.type) ? item.type : "Other";
	const safeFeeling = FEELINGS.has(item.feeling) ? item.feeling : "Okay";
	const safePage = sanitizeFeedbackRoute(item.page);

	const safeDevice = [
		"Desktop browser",
		"Mobile browser",
		"Tablet browser",
	].includes(item.device)
		? item.device
		: "Unknown";

	const titleMessage = Array.from(safeMessage.replace(/\s+/g, " ").trim())
		.slice(0, 60)
		.join("");

	let response: Response;

	try {
		response = await fetchImpl(
			"https://api.github.com/repos/kwilson21/tally-feedback/issues",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"Content-Type": "application/json",
					"User-Agent": "Tally feedback worker",
				},
				// Workers rejects redirect: "error"; a 3xx isn't ok, so it's treated as a failure.
				redirect: "manual",
				body: JSON.stringify({
					title: `${safeType}: ${titleMessage}`,
					// Code formatting keeps #123 and @someone from becoming links or mentions.
					body: [
						`Type: ${safeType}\nFeeling: ${safeFeeling}\nPage: ${codeSpan(safePage)}\nDevice category: ${safeDevice}\n\n${fenced(safeMessage)}`,
						...diagnosticLines(item),
					].join("\n"),
					labels: [safeType],
				}),
			},
		);
	} catch (error) {
		await db
			.prepare("UPDATE feedback SET filing_at = NULL WHERE id = ?")
			.bind(item.id)
			.run();
		throw error;
	}

	console.info(`Feedback GitHub status ${response.status}`);

	if (!response.ok) {
		await db
			.prepare(
				// 422: GitHub will never accept it, so give up. 401/403: the token is wrong,
				// not the row, so the attempt doesn't count.
				`UPDATE feedback SET last_status = ?1, filing_at = NULL,
					attempts = CASE WHEN ?1 = 422 THEN 5 WHEN ?1 IN (401, 403) THEN attempts - 1 ELSE attempts END
				WHERE id = ?2`,
			)
			.bind(response.status, item.id)
			.run();
		throw new FilingError(response.status);
	}

	// SAFETY: a successful GitHub create-issue response is a JSON object, and its number field is checked as an integer just below.
	const issue = (await response.json()) as { number?: number };

	if (!Number.isInteger(issue.number))
		throw new Error("Feedback GitHub response had no issue number");
	await db
		.prepare(
			"UPDATE feedback SET github_issue_number = ?, filed_at = CURRENT_TIMESTAMP, last_status = ? WHERE id = ?",
		)
		.bind(issue.number, response.status, item.id)
		.run();
}

export async function retryFeedback(
	env: { DB: D1Database; FEEDBACK_GITHUB_TOKEN?: string; DEMO?: string },
	fetchImpl: typeof fetch = fetch,
) {
	if (env.DEMO === "true" || !env.FEEDBACK_GITHUB_TOKEN) return;

	const rows = await env.DB.prepare(
		`SELECT * FROM feedback WHERE ${READY} AND created_at <= datetime('now', '-10 minutes') ORDER BY id LIMIT 20`,
	).all<FeedbackRow>();

	for (const row of rows.results) {
		try {
			await fileFeedbackIssue(
				env.DB,
				env.FEEDBACK_GITHUB_TOKEN,
				row,
				fetchImpl,
			);
		} catch (error) {
			if (
				error instanceof FilingError &&
				(error.status === 401 || error.status === 403)
			)
				break;
		}
	}
}

import { Hono } from "hono";
import {
	diagnosticsEnabled,
	normalizeFeedbackContext,
} from "../feedback/diagnostics";
import {
	sanitizeFeedbackMessage,
	sanitizeFeedbackRoute,
} from "../feedback/privacy";
import { FeedbackForm, type FeedbackValues } from "../views/feedback-form";
import { Layout } from "../views/layout";

type FeedbackEnv = Env & {
	FEEDBACK_GITHUB_TOKEN?: string;
	FEEDBACK_DIAGNOSTICS_ENABLED?: string;
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

const TYPES = new Set(["Bug", "Idea", "Question", "Other"]);
const FEELINGS = new Set([
	"Frustrated",
	"Confused",
	"Okay",
	"Happy",
	"Delighted",
]);

function safePath(value: string | null, navigation = false) {
	try {
		const url = new URL(value ?? "/", "http://tally.invalid");
		const normalized = url.pathname;
		return url.origin === "http://tally.invalid" &&
			(normalized === "/" || /^\/[^/\\]/.test(normalized))
			? navigation
				? `${normalized}${url.search}`
				: normalized.slice(0, 160)
			: "/";
	} catch {
		return "/";
	}
}

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
	} = {},
) {
	return (
		<Layout
			title="Send feedback · Tally"
			demo={demo}
			currentPath={`/feedback?from=${values.from}`}
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
	let from = "/";
	let returnTo = "/";
	const referer = c.req.header("referer");
	if (referer) {
		try {
			const url = new URL(referer);
			if (url.origin === new URL(c.req.url).origin) {
				from = sanitizeFeedbackRoute(url.pathname);
				returnTo = safePath(`${url.pathname}${url.search}`, true);
			}
		} catch {}
	}
	const existingToken = feedbackLimitId(c.req.header("cookie"));
	const response = c.html(
		view(
			{ type: "Bug", feeling: "Okay", message: "", from, returnTo },
			c.env.DEMO === "true",
			{
				diagnosticsEnabled: diagnosticsEnabled(c.env),
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
	const data = await c.req.formData();
	const rawType = String(data.get("type") ?? "");
	const rawFeeling = String(data.get("feeling") ?? "");
	const rawMessage = String(data.get("message") ?? "").replace(/\r\n/g, "\n");
	const values = {
		type: TYPES.has(rawType) ? rawType : "Other",
		feeling: FEELINGS.has(rawFeeling) ? rawFeeling : "Okay",
		message: sanitizeFeedbackMessage(rawMessage).trim(),
		from: sanitizeFeedbackRoute(String(data.get("from") ?? "/")),
		returnTo: safePath(
			String(data.get("return_to") ?? data.get("from") ?? "/"),
			true,
		),
	};
	const limitId = feedbackLimitId(c.req.header("cookie"));
	if (!limitId) {
		const response = await c.html(
			view(values, false, {
				error: "Your form expired. Review the cleaned message and send again.",
				diagnosticsEnabled: diagnosticsEnabled(c.env),
				reviewRequired: true,
			}),
			400,
		);
		return setFeedbackLimitCookie(response, crypto.randomUUID());
	}
	if (!rawMessage.trim() || rawMessage.length > 2000 || !values.message) {
		return c.html(
			view(values, false, {
				error:
					rawMessage.length > 2000
						? "Keep the message to 2,000 characters."
						: "Write a message before sending.",
				diagnosticsEnabled: diagnosticsEnabled(c.env),
			}),
			422,
		);
	}
	if (String(data.get("message_reviewed") ?? "") !== values.message) {
		return c.html(
			view(values, false, {
				error: "Review the cleaned message, confirm below, and send again.",
				diagnosticsEnabled: diagnosticsEnabled(c.env),
				reviewRequired: true,
			}),
		);
	}
	const diagnosticsOn = diagnosticsEnabled(c.env);
	let clientContext: ReturnType<typeof normalizeFeedbackContext> = null;
	if (diagnosticsOn && data.get("include_diagnostics") === "yes") {
		try {
			clientContext = normalizeFeedbackContext(
				JSON.parse(String(data.get("client_context") ?? "")),
				values.from,
			);
		} catch {
			clientContext = null;
		}
	}
	const columns = diagnosticsOn ? ", client_context" : "";
	const placeholders = diagnosticsOn ? ", ?" : "";
	const device =
		String(data.get("device_category")) === "Mobile browser"
			? "Mobile browser"
			: String(data.get("device_category")) === "Tablet browser"
				? "Tablet browser"
				: String(data.get("device_category")) === "Desktop browser"
					? "Desktop browser"
					: "Unknown";
	const params: (string | null)[] = [
		limitId,
		values.type,
		values.feeling,
		values.message.trim(),
		values.from,
		device,
	];
	if (diagnosticsOn)
		params.push(clientContext ? JSON.stringify(clientContext) : null);
	params.push(limitId);
	const result = await c.env.DB.prepare(
		`INSERT INTO feedback (actor, type, feeling, message, page, device${columns})
		 SELECT ?, ?, ?, ?, ?, ?${placeholders}
		 WHERE (SELECT COUNT(*) FROM feedback WHERE actor = ? AND created_at > datetime('now', '-1 hour')) < 10`,
	)
		.bind(...params)
		.run();
	if (result.meta.changes === 0) {
		return c.html(
			view(values, false, {
				error: "You've sent 10 messages this hour. Try again later.",
				diagnosticsEnabled: diagnosticsOn,
			}),
			429,
		);
	}
	if (c.env.FEEDBACK_GITHUB_TOKEN) {
		const row = await c.env.DB.prepare("SELECT * FROM feedback WHERE id = ?")
			.bind(result.meta.last_row_id)
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
	row: FeedbackRow | Record<string, unknown>,
	fetchImpl: typeof fetch = fetch,
) {
	const item = row as FeedbackRow;
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

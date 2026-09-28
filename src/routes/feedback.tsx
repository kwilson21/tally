import { Hono } from "hono";
import { FeedbackForm, type FeedbackValues } from "../views/feedback-form";
import { Layout } from "../views/layout";

type FeedbackEnv = Env & { FEEDBACK_GITHUB_TOKEN?: string };
type App = { Bindings: FeedbackEnv; Variables: { actor: string } };
export const feedback = new Hono<App>();

type FeedbackRow = {
	id: number;
	type: string;
	feeling: string;
	message: string;
	page: string;
	device: string;
};

const TYPES = new Set(["Bug", "Idea", "Question", "Other"]);
const FEELINGS = new Set([
	"Frustrated",
	"Confused",
	"Okay",
	"Happy",
	"Delighted",
]);

function safePath(value: string | null) {
	if (!value?.startsWith("/") || value.startsWith("//")) return "/";
	try {
		const url = new URL(value, "http://tally.invalid");
		return url.origin === "http://tally.invalid"
			? `${url.pathname}${url.search}${url.hash}`
			: "/";
	} catch {
		return "/";
	}
}

export function summarizeDevice(userAgent: string) {
	const browser = /Edg\//.test(userAgent)
		? "Edge"
		: /Firefox\//.test(userAgent)
			? "Firefox"
			: /(?:Chrome|CriOS)\//.test(userAgent)
				? "Chrome"
				: /Safari\//.test(userAgent)
					? "Safari"
					: "browser";
	const device = /iPhone/.test(userAgent)
		? "iPhone"
		: /iPad/.test(userAgent)
			? "iPad"
			: /Android/.test(userAgent)
				? "Android"
				: "Desktop";
	return `${device} ${browser}`;
}

function view(values: FeedbackValues, demo: boolean, error?: string) {
	return (
		<Layout
			title="Send feedback · Tally"
			demo={demo}
			currentPath={`/feedback?from=${values.from}`}
		>
			<FeedbackForm values={values} demo={demo} error={error} />
		</Layout>
	);
}

feedback.get("/feedback", (c) => {
	const from = safePath(c.req.query("from") ?? null);
	return c.html(
		view(
			{ type: "Bug", feeling: "Okay", message: "", from },
			c.env.DEMO === "true",
		),
	);
});

feedback.post("/feedback", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const origin = c.req.header("origin");
	if (!origin || origin !== new URL(c.req.url).origin) return c.body(null, 403);
	const data = await c.req.formData();
	const rawType = String(data.get("type") ?? "");
	const rawFeeling = String(data.get("feeling") ?? "");
	const values = {
		type: TYPES.has(rawType) ? rawType : "Other",
		feeling: FEELINGS.has(rawFeeling) ? rawFeeling : "Okay",
		message: String(data.get("message") ?? ""),
		from: safePath(String(data.get("from") ?? "/")),
	};
	if (!values.message.trim() || values.message.length > 2000) {
		return c.html(
			view(
				values,
				false,
				values.message.length > 2000
					? "Keep the message to 2,000 characters."
					: "Write a message before sending.",
			),
			422,
		);
	}
	const actor = c.get("actor");
	const recent = await c.env.DB.prepare(
		"SELECT COUNT(*) AS count FROM feedback WHERE actor = ? AND created_at >= datetime('now', '-1 hour')",
	)
		.bind(actor)
		.first<{ count: number }>();
	if ((recent?.count ?? 0) >= 10) {
		return c.html(
			view(
				values,
				false,
				"You've sent 10 messages this hour. Try again later.",
			),
			429,
		);
	}
	const result = await c.env.DB.prepare(
		"INSERT INTO feedback (actor, type, feeling, message, page, device) VALUES (?, ?, ?, ?, ?, ?)",
	)
		.bind(
			actor,
			values.type,
			values.feeling,
			values.message.trim(),
			values.from,
			summarizeDevice(c.req.header("user-agent") ?? ""),
		)
		.run();
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
	const back = new URL(values.from, "http://tally.invalid");
	back.searchParams.set("toast", "Thanks. Sent.");
	back.searchParams.set("announce", "Thanks. Sent.");
	return c.redirect(`${back.pathname}${back.search}${back.hash}`, 303);
});

export async function fileFeedbackIssue(
	db: D1Database,
	token: string,
	row: FeedbackRow | Record<string, unknown>,
	fetchImpl: typeof fetch = fetch,
) {
	const item = row as FeedbackRow;
	const response = await fetchImpl(
		"https://api.github.com/repos/kwilson21/tally-feedback/issues",
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"User-Agent": "Tally feedback worker",
			},
			body: JSON.stringify({
				title: `${item.type}: ${item.message.slice(0, 60)}`,
				body: `Type: ${item.type}\nFeeling: ${item.feeling}\nPage: ${item.page}\nDevice: ${item.device}\n\n${item.message}`,
				labels: [item.type],
			}),
		},
	);
	console.info(`Feedback GitHub status ${response.status}`);
	if (!response.ok)
		throw new Error(`Feedback GitHub request failed (${response.status})`);
	const issue = (await response.json()) as { number?: number };
	if (!Number.isInteger(issue.number))
		throw new Error("Feedback GitHub response had no issue number");
	await db
		.prepare(
			"UPDATE feedback SET github_issue_number = ?, filed_at = CURRENT_TIMESTAMP WHERE id = ?",
		)
		.bind(issue.number, item.id)
		.run();
}

export async function retryFeedback(
	env: { DB: D1Database; FEEDBACK_GITHUB_TOKEN?: string; DEMO?: string },
	fetchImpl: typeof fetch = fetch,
) {
	if (env.DEMO === "true" || !env.FEEDBACK_GITHUB_TOKEN) return;
	const rows = await env.DB.prepare(
		"SELECT * FROM feedback WHERE github_issue_number IS NULL ORDER BY id",
	).all<FeedbackRow>();
	for (const row of rows.results) {
		try {
			await fileFeedbackIssue(
				env.DB,
				env.FEEDBACK_GITHUB_TOKEN,
				row,
				fetchImpl,
			);
		} catch {
			// The status was logged without the feedback or token; the row stays ready for tomorrow.
		}
	}
}

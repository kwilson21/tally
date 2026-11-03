import { type Context, Hono } from "hono";
import {
	closeToastOnce,
	readMoved,
	readRun,
	UNDO_MS,
	undoRun,
} from "../db/resort-run";
import { isRunning } from "../db/resort-start";
import { hxTrigger } from "../htmx";
import {
	closingToast,
	FINISHED_ANNOUNCEMENT,
	undoWords,
} from "../resort-toast";
import {
	heldQuarter,
	RecheckMilestoneSwap,
	RecheckSentence,
	recheckDone,
	recheckMilestone,
} from "../views/recheck-line";
import { organizeAgain } from "./organize";
import { categoriesAgain } from "./settings";
import { suggestionsAgain } from "./suggestions";

// The re-check's progress poll and its Undo (decisions 159 and 160, #821). The poll answers with the sentence while its
// run goes; once the run has ended, its first answer claims the closing toast (and Undo's ten seconds) and the answer
// is empty, so the sentence and its polling leave the page. The claim lives in the run's own record, so an old run's
// poll still delivers its toast after a newer run has replaced resort_run.

type App = { Bindings: Env };

export const resort = new Hono<App>();

/** The pages a Create can land on, by their path: each one draws its own page again for the Undo answer. */
const AGAIN: Record<
	string,
	(c: Context<App>, back: URL) => Response | Promise<Response>
> = {
	"/settings/suggestions": suggestionsAgain,
	"/transactions/organize": organizeAgain,
	"/settings/categories": categoriesAgain,
};

/** A back address that stays on this site: one path that starts with a single slash, with no backslash (#842 review). */
const SITE_BASE = "http://tally.invalid";
function siteBack(back: string): URL | null {
	if (!back.startsWith("/") || back.startsWith("//") || back.includes("\\"))
		return null;
	return new URL(back, SITE_BASE);
}

resort.get("/resort/progress", async (c) => {
	c.header("Cache-Control", "no-store");
	const db = c.env.DB;
	const runId = c.req.query("run") ?? "";
	const now = Date.now();
	const current = await readRun(db);
	if (current && current.id === runId && isRunning(current, now)) {
		const run = { id: current.id, done: current.done, total: current.total };
		// The quarter the page holds (`m`): the hidden region is sent again only when a new quarter is crossed (#821).
		const held = heldQuarter(c.req.query("m"));
		const milestone = recheckMilestone(recheckDone(run), run.total);
		return c.html(
			<>
				<RecheckSentence run={run} />
				{milestone !== held ? <RecheckMilestoneSwap run={run} /> : null}
			</>,
		);
	}
	// Finished, unknown or expired: the first answer claims the toast, and every later one, and an unknown id, says nothing.
	if (runId === "" || !(await closeToastOnce(db, runId, now)))
		return c.body(null);
	const record = await readMoved(db, runId);
	const words = record
		? closingToast({
				moved: record.rows.length,
				needAnswer: record.needAnswer,
				byCategory: record.byCategory,
			})
		: null;
	c.header(
		"HX-Trigger",
		hxTrigger({
			...(words
				? {
						toast: {
							message: words.message,
							type: words.type,
							// A background poll's toast never takes focus (toast.js, #821 owner feedback).
							passive: true,
							...(words.undo
								? {
										undo: runId,
										undoExpiresInMs: UNDO_MS,
										undoAction: "/resort/undo",
									}
								: {}),
						},
					}
				: {}),
			announce: words?.message ?? FINISHED_ANNOUNCEMENT,
		}),
	);
	return c.body(null);
});

// Undo of a re-check (decision 160): puts back only the rows the run moved, while the ten seconds are open. The form
// posts the run's id as `token` and the page's own address as `back`; the answer draws that page again (htmx swaps its
// #page), with the words and the ending of the Undo toast.
resort.post("/resort/undo", async (c) => {
	const form = await c.req.formData();
	const runId = String(form.get("token") ?? "");
	// The page to draw, from its own address: only a known page on this site (#842 review), else the Suggestions page.
	const target = siteBack(String(form.get("back") ?? ""));
	const known = target !== null && Object.hasOwn(AGAIN, target.pathname);
	const outcome = runId
		? await undoRun(c.env.DB, { runId, now: Date.now() })
		: { expired: true, restored: 0, changedSince: 0 };
	const { message, type } = undoWords(outcome);
	if (!c.req.header("HX-Request")) {
		return c.redirect(
			known && target
				? target.pathname + target.search
				: "/settings/suggestions",
			303,
		);
	}
	c.header(
		"HX-Trigger",
		hxTrigger({
			toast: { message, type, undoDone: runId },
			announce: message,
		}),
	);
	const page =
		known && target ? target : new URL("/settings/suggestions", SITE_BASE);
	return (AGAIN[page.pathname] ?? suggestionsAgain)(c, page);
});

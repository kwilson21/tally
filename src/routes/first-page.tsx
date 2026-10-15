import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { householdToday } from "../dates";
import {
	answerPay,
	type FirstPageModel,
	keepBills,
	settleAndLoad,
} from "../first-tally/first-page";
import { readQuestionsGate } from "../first-tally/gate";
import { FirstPageBody, type Motion, NO_MOTION } from "../views/first-page";
import { Layout } from "../views/layout";

// The question page (P125 E, spec §8.8, decision 114): the family app only, opened once the gate is open. Each answer
// is a POST that writes it, draws the step's stroke when the step is done, and swaps the page; without JavaScript it
// redirects back to the page.

type App = { Bindings: Env; Variables: { actor: string } };

export const firstPage = new Hono<App>();

/** Not open yet: an HTMX request is sent Home by HX-Redirect (a redirect would swap Home into the page). */
function notOpen(c: Context<App>) {
	if (c.req.header("HX-Request")) {
		c.header("HX-Redirect", "/");
		return c.body(null, 204);
	}
	return c.redirect("/", 303);
}

/**
 * What the answer changed between the page before it and the page after: the ledger line it wrote (its index, since the
 * ledger is in merchant order, not answer order), and the strokes it drew. The strokes are the next indexes after the
 * `drawn` already there (the bank's stroke is index 0, so the first drawn after it is index 1). One answer can draw
 * two, when the step after it has nothing to ask.
 */
function motionOf(before: FirstPageModel, after: FirstPageModel): Motion {
	const written = after.ledger.findIndex(
		(line) => !before.ledger.includes(line),
	);
	return {
		line: written === -1 ? null : written,
		strokes: Array.from(
			{ length: after.drawn - before.drawn },
			(_, i) => before.drawn + i,
		),
	};
}

/** The page after an answer: the swap, and the answer announced and toasted (both keys, spec CLAUDE.md). */
function answered(
	c: Context<App>,
	model: FirstPageModel,
	message: string,
	motion: Motion,
) {
	if (!c.req.header("HX-Request")) return c.redirect("/first-page", 303);
	return c.html(<FirstPageBody model={model} focus motion={motion} />, 200, {
		"HX-Trigger": JSON.stringify({
			toast: { message, type: "success" },
			announce: message,
		}),
	});
}

firstPage.get("/first-page", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB, today))) return notOpen(c);
	const model = await settleAndLoad(c.env.DB, today);
	return c.html(
		<Layout
			title="Your first page · Tally"
			demo={false}
			currentPath={c.req.path}
		>
			<div class="max-w-2xl">
				<FirstPageBody model={model} focus={false} />
			</div>
		</Layout>,
	);
});

firstPage.post("/first-page/pay", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB, today))) return notOpen(c);
	const form = await c.req.parseBody();
	const key = String(form.merchant ?? "");
	const answer = String(form.answer ?? "");
	if (answer !== "yes" && answer !== "no")
		return c.text("Choose yes or no.", 400);
	const before = await settleAndLoad(c.env.DB, today);
	const merchant = before.pay.find((m) => m.key === key);
	if (!merchant) {
		// Nothing left to ask about this merchant: the swap shows the page as it is, and changes nothing.
		return answered(c, before, "That one is already answered.", NO_MOTION);
	}
	await answerPay(c.env.DB, key, answer, actor(c));
	const after = await settleAndLoad(c.env.DB, today);
	return answered(
		c,
		after,
		answer === "yes"
			? `Saved: ${merchant.name} is your pay.`
			: `Saved: ${merchant.name} isn't your pay.`,
		motionOf(before, after),
	);
});

firstPage.post("/first-page/bills", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB, today))) return notOpen(c);
	const before = await settleAndLoad(c.env.DB, today);
	const bills = await keepBills(c.env.DB, today, before.keep);
	const after = await settleAndLoad(c.env.DB, today, bills);
	const message =
		bills.kept === 0
			? "Nothing to keep."
			: bills.kept === 1
				? "Kept 1 bill."
				: `Kept ${bills.kept} bills.`;
	return answered(c, after, message, motionOf(before, after));
});

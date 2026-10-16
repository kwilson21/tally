import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { householdToday } from "../dates";
import type { PayAnswer } from "../db/first-tally";
import { keepReply, keepShown } from "../first-tally/bills";
import {
	answerPay,
	type FirstPageModel,
	keepBills,
	type PayMerchant,
	settleAndLoad,
} from "../first-tally/first-page";
import { readQuestionsGate } from "../first-tally/gate";
import { payShown } from "../first-tally/pay";
import { hxTrigger } from "../htmx";
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
 * What the answer changed between the page before it and the page after: the ledger line it wrote, found by the line's
 * id (`written`, null when it wrote none) so two lines that read the same are told apart, and the strokes it drew. The
 * ledger is in the order each merchant was first answered, the pay lines first and then the bills line. The strokes are
 * the next indexes after the `drawn` already there (the bank's stroke is index 0, so the first drawn after it is index
 * 1). One answer can draw two, when the step after it has nothing to ask.
 */
function motionOf(
	before: FirstPageModel,
	after: FirstPageModel,
	written: string | null,
): Motion {
	const index =
		written === null
			? -1
			: after.ledger.findIndex((line) => line.id === written);
	return {
		line: index === -1 ? null : index,
		strokes: Array.from(
			{ length: after.drawn - before.drawn },
			(_, i) => before.drawn + i,
		),
	};
}

/**
 * The page after a reply: the swap, and the reply announced and toasted (both keys, spec CLAUDE.md). The toast is a
 * success when an answer was written, and info when the reply changed nothing (`stale`).
 */
function answered(
	c: Context<App>,
	model: FirstPageModel,
	message: string,
	motion: Motion,
	type: "success" | "info" = "success",
) {
	if (!c.req.header("HX-Request")) return c.redirect("/first-page", 303);
	return c.html(<FirstPageBody model={model} focus motion={motion} />, 200, {
		"HX-Trigger": hxTrigger({
			toast: { message, type },
			announce: message,
		}),
	});
}

/**
 * The reply to an answer that changed nothing: its merchant has nothing left to ask, or a competing answer got there
 * first. It writes nothing, so the page is the page as it is now with no motion, and the toast is info, not a success.
 */
function stale(c: Context<App>, model: FirstPageModel) {
	return answered(c, model, "That one is already answered.", NO_MOTION, "info");
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

/**
 * A pay answer covers only the deposits the page showed: its `deposit` fields, each checked against the merchant's
 * deposits now (payShown). When one is new or changed since the page drew, nothing is written and the question is drawn
 * again.
 */
firstPage.post("/first-page/pay", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB, today))) return notOpen(c);
	const form = await c.req.formData();
	const key = String(form.get("merchant") ?? "");
	const answer = String(form.get("answer") ?? "");
	const shown = form
		.getAll("deposit")
		.filter((value): value is string => typeof value === "string");
	if (answer !== "yes" && answer !== "no")
		return c.text("Choose yes or no.", 400);
	const before = await settleAndLoad(c.env.DB, today);
	const merchant = before.pay.find((m) => m.key === key);
	// Nothing left to ask about this merchant: the page as it is now, and nothing written.
	if (!merchant) return stale(c, await settleAndLoad(c.env.DB, today));
	if (!payShown(merchant, shown))
		return answered(
			c,
			before,
			`Nothing saved. The deposits from ${merchant.name} changed since the page drew, so the question is asked again below.`,
			NO_MOTION,
			"info",
		);
	// A competing answer changed no row first: the page as it is now, and nothing written. The re-read is fresh, since
	// `before` may be stale by now.
	const hadYesLine = before.ledger.some(
		(line) => line.id === `pay:${merchant.key}`,
	);
	if ((await answerPay(c.env.DB, merchant, answer, actor(c))) === 0)
		return stale(c, await settleAndLoad(c.env.DB, today));
	const after = await settleAndLoad(c.env.DB, today);
	return answered(
		c,
		after,
		paySaved(answer, merchant, hadYesLine),
		motionOf(before, after, answer === "yes" ? `pay:${merchant.key}` : null),
	);
});

/**
 * The words a pay answer saves. A No for a merchant whose Yes line is already there says only what it covered, since
 * that line stays on the page and still reads the earlier Yes deposits.
 */
function paySaved(
	answer: PayAnswer,
	merchant: PayMerchant,
	hadYesLine: boolean,
): string {
	if (answer === "yes") return `Saved: ${merchant.name} is your pay.`;
	if (!hadYesLine) return `Saved: ${merchant.name} isn't your pay.`;
	return merchant.ids.length === 1
		? `Saved: that deposit from ${merchant.name} isn't your pay.`
		: `Saved: those ${merchant.ids.length} deposits from ${merchant.name} aren't your pay.`;
}

firstPage.post("/first-page/bills", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB, today))) return notOpen(c);
	// Only the charges the form showed are kept: its `keep` fields, each one re-checked against the charges now. An
	// empty form keeps none, and a charge that is new or changed since the page drew is asked again on the page.
	const values = (await c.req.formData())
		.getAll("keep")
		.filter((value): value is string => typeof value === "string");
	const before = await settleAndLoad(c.env.DB, today);
	const bills = await keepBills(
		c.env.DB,
		today,
		keepShown(before.keep, values),
	);
	const after = await settleAndLoad(c.env.DB, today);
	return answered(
		c,
		after,
		keepReply(bills.kept, after.keep.length),
		motionOf(before, after, bills.kept > 0 ? "bills" : null),
		bills.kept === 0 ? "info" : "success",
	);
});

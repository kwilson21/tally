import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { parseBudgetAmount } from "../budgets/amount";
import { householdToday } from "../dates";
import type { BudgetAnswer, PayAnswer } from "../db/first-tally";
import { keepReply, keepShown } from "../first-tally/bills";
import {
	type BudgetAsk,
	budgetChangedWords,
	budgetsMovedOnWords,
	keepShownBudgets,
	keptBudgetsWords,
	savedBudgetWords,
	shownBudgetIds,
	skippedBudgetWords,
} from "../first-tally/budgets";
import {
	answerPay,
	type FirstPageModel,
	keepBills,
	keepBudgetAnswers,
	type PayMerchant,
	settleAndLoad,
} from "../first-tally/first-page";
import { readQuestionsGate } from "../first-tally/gate";
import { payShown } from "../first-tally/pay";
import { hxTrigger } from "../htmx";
import {
	type BudgetError,
	FirstPageBody,
	type Motion,
	NO_MOTION,
} from "../views/first-page";
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

/**
 * The question page as a whole document: the GET's page, and a refused amount's page when JavaScript is off (the page
 * with its error, not a redirect, which would lose both). `focus` moves the focus to the question.
 */
function pageDocument(
	model: FirstPageModel,
	focus: boolean,
	budgetError: BudgetError | null = null,
) {
	return (
		<Layout
			title="Your first page · Tally"
			demo={false}
			currentPath="/first-page"
		>
			<div class="max-w-2xl">
				<FirstPageBody model={model} focus={focus} budgetError={budgetError} />
			</div>
		</Layout>
	);
}

firstPage.get("/first-page", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB, today))) return notOpen(c);
	// "One at a time" links here (?budgets=one), so the budgets question takes focus on the visit it asks for.
	const oneAtATime = c.req.query("budgets") === "one";
	const model = await settleAndLoad(c.env.DB, today, { oneAtATime });
	return c.html(pageDocument(model, oneAtATime));
});

/**
 * A pay answer covers only the deposits the page showed: its `deposit` fields, each checked against the merchant's
 * deposits now (payShown here, and again inside answerPay's batch). When one is new or changed since the page drew,
 * nothing is written and the question is drawn again.
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
	if (!payShown(merchant, shown)) return payChanged(c, before, merchant.name);
	const hadYesLine = before.ledger.some(
		(line) => line.id === `pay:${merchant.key}`,
	);
	const written = await answerPay(c.env.DB, merchant, answer, actor(c));
	// The re-read is fresh, since `before` may be stale by now. With 0 rows written, a shown deposit still asked about
	// means a sync changed it after the check above, so the question is asked again with payChanged's words. Otherwise a
	// competing answer changed the rows first, and the page is the page as it is now (stale).
	const after = await settleAndLoad(c.env.DB, today);
	if (written === 0) {
		return after.pay.some((m) => m.ids.some((id) => merchant.ids.includes(id)))
			? payChanged(c, after, merchant.name)
			: stale(c, after);
	}
	return answered(
		c,
		after,
		paySaved(answer, merchant, hadYesLine),
		motionOf(before, after, answer === "yes" ? `pay:${merchant.key}` : null),
	);
});

/** The reply when a shown deposit changed since the page drew: nothing saved, and the question asked again. */
function payChanged(c: Context<App>, model: FirstPageModel, name: string) {
	return answered(
		c,
		model,
		`Nothing saved. The deposits from ${name} changed since the page drew, so the question is asked again below.`,
		NO_MOTION,
		"info",
	);
}

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

/**
 * The budgets question's answers (spec §8.8, #590). Keep all keeps the suggestions the page showed, each re-checked as
 * Keep does. One category's Yes keeps its suggestion when the amount is the one the page showed; another amount is read
 * by the budget sheet's own rule (parseBudgetAmount); a skip keeps the skip. An answer for a category that isn't the first
 * one asked writes nothing, and the first question is asked again (#697). A change since the page drew is asked again,
 * and a refused amount draws the question again with its error. A form drawn in another household month writes nothing
 * and gets the current month's question. Each answer is one batch with its budget and the stroke.
 */
firstPage.post("/first-page/budgets", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB, today))) return notOpen(c);
	const form = await c.req.formData();
	const answer = String(form.get("answer") ?? "");
	if (!["all", "yes", "another", "skip"].includes(answer))
		return c.text("Choose an answer.", 400);
	// Keep all is the only answer to its own question; every other answer is one at a time, so its page is drawn that way.
	const before = await settleAndLoad(c.env.DB, today, {
		oneAtATime: answer !== "all",
	});
	const step = before.budgets;
	if (!step || step.done) return stale(c, before);
	// A form drawn in another household month writes nothing, since its amounts and 'From <month> on' were for that month.
	if (form.get("month") !== step.month)
		return answered(c, before, budgetsMovedOnWords(), NO_MOTION, "info");
	if (answer === "all") {
		const suggested = step.asks.filter((ask) => ask.suggestion !== null);
		const values = form
			.getAll("keep")
			.filter((value): value is string => typeof value === "string");
		const writes = keepShownBudgets(suggested, values).flatMap(
			(ask): { ask: BudgetAsk; answer: BudgetAnswer }[] =>
				ask.suggestion
					? [
							{
								ask,
								answer: {
									kind: "suggested",
									cents: ask.suggestion.amountCents,
								},
							},
						]
					: [],
		);
		const landed =
			writes.length === 0
				? []
				: await keepBudgetAnswers(c.env.DB, today, step.firstDate, writes);
		const after =
			writes.length === 0 ? before : await settleAndLoad(c.env.DB, today);
		// Changed counts what the page showed and is still asked, and that didn't land: a suggestion that moved, or one that
		// has no suggestion now. A category a Home budget set since is no longer asked, so it is neither kept nor changed.
		const asked = askedIds(after);
		const changed = shownBudgetIds(values).filter(
			(id) => !landed.includes(id) && asked.has(id),
		).length;
		if (landed.length === 0)
			return answered(
				c,
				after,
				keptBudgetsWords(0, changed),
				NO_MOTION,
				"info",
			);
		return answered(
			c,
			after,
			keptBudgetsWords(landed.length, changed),
			motionOf(before, after, "budgets"),
		);
	}
	const id = Number(form.get("category"));
	const ask = step.asks.find((candidate) => candidate.id === id);
	if (!ask) return stale(c, before);
	// Only the question on the page is answered. A stale tab's answer for another category writes nothing, and the page
	// draws that first question again, so a refused amount's error is always the first question's own.
	if (step.asks[0]?.id !== ask.id)
		return answered(c, before, budgetsMovedOnWords(), NO_MOTION, "info");
	if (answer === "skip") {
		const landed = await keepBudgetAnswers(c.env.DB, today, step.firstDate, [
			{ ask, answer: { kind: "skipped", cents: null } },
		]);
		const after = await settleAndLoad(c.env.DB, today, { oneAtATime: true });
		if (landed.length === 0) return budgetNotSaved(c, after, ask);
		return answered(
			c,
			after,
			skippedBudgetWords(ask.name),
			motionOf(before, after, null),
		);
	}
	let kind: "suggested" | "another";
	let cents: number;
	if (answer === "yes") {
		const suggestion = ask.suggestion;
		// The amount the page showed is the one kept; a suggestion that moved since is asked again.
		if (!suggestion || Number(form.get("shown")) !== suggestion.amountCents)
			return answered(
				c,
				before,
				budgetChangedWords(ask.name),
				NO_MOTION,
				"info",
			);
		kind = "suggested";
		cents = suggestion.amountCents;
	} else {
		const typed = String(form.get("budget") ?? "");
		const parsed = parseBudgetAmount(typed);
		if (!parsed.ok) return budgetRefused(c, before, parsed.error, typed);
		kind = "another";
		cents = parsed.cents;
	}
	const landed = await keepBudgetAnswers(c.env.DB, today, step.firstDate, [
		{ ask, answer: { kind, cents } },
	]);
	const after = await settleAndLoad(c.env.DB, today, { oneAtATime: true });
	if (landed.length === 0) return budgetNotSaved(c, after, ask);
	return answered(
		c,
		after,
		savedBudgetWords(ask.name, cents),
		motionOf(before, after, "budgets"),
	);
});

/** The categories the budgets step still asks, by id: none once the step is done. */
function askedIds(model: FirstPageModel): Set<number> {
	return new Set(
		model.budgets && !model.budgets.done
			? model.budgets.asks.map((ask) => ask.id)
			: [],
	);
}

/**
 * The reply to a budget answer that saved nothing. Its category is still asked when its suggestion moved since the page
 * drew, so it is asked again with that said. Otherwise a Home budget or a competing answer got there first (stale).
 */
function budgetNotSaved(
	c: Context<App>,
	model: FirstPageModel,
	ask: BudgetAsk,
) {
	return askedIds(model).has(ask.id)
		? answered(c, model, budgetChangedWords(ask.name), NO_MOTION, "info")
		: stale(c, model);
}

/**
 * A typed amount that isn't a dollar amount: nothing is saved, and the question is drawn again with its error, its field
 * holding what was typed. htmx swaps the question in with a toast; without JavaScript the whole page comes back at 422
 * with the same error, as Home's refused amount does.
 */
function budgetRefused(
	c: Context<App>,
	model: FirstPageModel,
	error: string,
	typed: string,
) {
	const budgetError = { text: error, typed };
	if (!c.req.header("HX-Request"))
		return c.html(pageDocument(model, true, budgetError), 422);
	return c.html(
		<FirstPageBody
			model={model}
			focus
			motion={NO_MOTION}
			budgetError={budgetError}
		/>,
		422,
		{
			"HX-Trigger": hxTrigger({
				toast: { message: error, type: "error" },
				announce: error,
			}),
		},
	);
}

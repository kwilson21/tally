import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { parseBudgetAmount } from "../budgets/amount";
import { householdToday } from "../dates";
import {
	type BudgetAnswer,
	type PayAnswer,
	readFirstTally,
	strokeStatement,
} from "../db/first-tally";
import { currentGoalSql, savingsGoalStatement } from "../db/savings-goals";
import { keepHeading, keepReply, keepShown } from "../first-tally/bills";
import {
	askHeading,
	type BudgetAsk,
	budgetChangedWords,
	budgetsMonthChangedWords,
	budgetsMovedOnWords,
	homeSavingsWords,
	keepAllQuestion,
	keepShownBudgets,
	keptBudgetsWords,
	SAVINGS_BLANK_WORDS,
	SKIPPED_SAVINGS_WORDS,
	savedBudgetWords,
	savedSavingsWords,
	shownBudgetIds,
	skippedBudgetWords,
} from "../first-tally/budgets";
import {
	answerPay,
	budgetsStepShown,
	budgetsStrokeGuard,
	type FirstPageModel,
	keepBills,
	keepBudgetAnswers,
	type PayMerchant,
	savingsAnswerStatement,
	savingsOpen,
	settleAndLoad,
} from "../first-tally/first-page";
import { readQuestionsGate } from "../first-tally/gate";
import { payShown } from "../first-tally/pay";
import { skippedNotes } from "../first-tally/skipped";
import { hxTrigger } from "../htmx";
import { type BudgetError, RuledTotal } from "../views/first-page";
import { Layout } from "../views/layout";
import {
	SetupBills,
	SetupBudgets,
	SetupOneBudget,
	SetupPay,
	SetupSavings,
} from "../views/setup-questions";
import { SetupScreen } from "../views/setup-screen";

// The setup questions' answers (P142 A, spec §8.8, decision 148, #773): the questions are asked at /setup, one screen at a
// time, and each answer is a POST here that writes it and swaps the screen (#setup-screen). Without JavaScript the answer
// redirects back to /setup. /first-page, the question page this replaced, now sends a family to /setup.

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

/** The options a question screen takes: whether its heading takes the focus, and a refused amount's or Save it's words. */
type ScreenOptions = {
	focus: boolean;
	budgetError?: BudgetError | null;
	savingsError?: BudgetError | null;
};

/**
 * The question screen a model draws (P142 A, #773), in FirstPageBody's order: the pay question while a merchant is left, then
 * the bills question while charges are kept, then the budgets step. Once the step is done it is the ruled-off total; with no
 * category left to ask it is the savings question; keep all while it is the one asked, else one category. `focus` moves the
 * focus to the screen's heading (a refused amount's field takes it instead), and the check-in follows the model's `watching`.
 */
export function questionScreen(
	model: FirstPageModel,
	{ focus, budgetError = null, savingsError = null }: ScreenOptions,
) {
	const notes = skippedNotes(model);
	const merchant = model.pay[0];
	if (merchant)
		return (
			<SetupPay merchant={merchant} focus={focus} watching={model.watching} />
		);
	if (model.keep.length > 0)
		return (
			<SetupBills
				keep={model.keep}
				waiting={model.waiting}
				focus={focus}
				watching={model.watching}
				skipped={notes}
			/>
		);
	const budgets = model.budgets;
	// settleAndLoad reads the budgets step whenever pay and bills have nothing left to ask, so no page reaches this with none.
	// The type allows null, and the page has no screen to draw then.
	if (!budgets) return null;
	if (budgets.done)
		return (
			<SetupScreen>
				<RuledTotal
					safeCents={budgets.safeCents}
					focus={focus}
					nothingAsked={budgets.nothingAsked}
				/>
			</SetupScreen>
		);
	if (budgets.asks.length === 0)
		return (
			<SetupSavings
				month={budgets.month}
				focus={focus}
				watching={model.watching}
				error={savingsError}
				skipped={notes}
			/>
		);
	if (budgets.keepAllOpen)
		return (
			<SetupBudgets
				asks={budgets.asks.filter((ask) => ask.suggestion !== null)}
				month={budgets.month}
				needs={budgets.needs}
				focus={focus}
				watching={model.watching}
				skipped={notes}
			/>
		);
	const next = budgets.asks[0];
	if (!next) return null;
	return (
		<SetupOneBudget
			ask={next}
			month={budgets.month}
			needs={budgets.needs}
			focus={focus}
			watching={model.watching}
			skipped={notes}
			error={budgetError}
			amountOpen={false}
		/>
	);
}

/**
 * A question screen as a response's body. Pay and bills are done before the budgets step is read, so a page reaches here with
 * one; questionScreen's null is the type's only, and it is an error here.
 */
export function drawQuestionScreen(
	model: FirstPageModel,
	options: ScreenOptions,
) {
	const screen = questionScreen(model, options);
	if (screen === null)
		throw new Error("setup's budgets step is read before its question screen");
	return screen;
}

/**
 * The heading the question screen draws (its h1), or null for the ruled-off total, which asks nothing. The in-place redraw
 * announces it, so the words here are the screen's own.
 */
export function questionHeading(model: FirstPageModel): string | null {
	if (model.pay[0]) return "Is this your pay?";
	if (model.keep.length > 0) return keepHeading(model.keep.length);
	const budgets = model.budgets;
	if (!budgets || budgets.done) return null;
	if (budgets.asks.length === 0) return "Save some each month?";
	if (budgets.keepAllOpen)
		return keepAllQuestion(
			budgets.asks.filter((ask) => ask.suggestion !== null).length,
		);
	const next = budgets.asks[0];
	return next ? askHeading(next) : null;
}

/**
 * The questions as a whole page (GET /setup, once the questions are open): the setup layout around the question screen, with no
 * Plaid script and no push. `focus` moves the focus to the question; a refused amount passes its error (without JavaScript).
 */
export function questionsPage(
	model: FirstPageModel,
	focus: boolean,
	budgetError: BudgetError | null = null,
	savingsError: BudgetError | null = null,
) {
	return (
		<Layout setup title="Setup · Tally" demo={false} currentPath="/setup">
			{questionScreen(model, { focus, budgetError, savingsError })}
		</Layout>
	);
}

/**
 * The page after a reply: the screen swapped (#setup-screen), and the reply announced and toasted (both keys, spec CLAUDE.md).
 * The toast is a success when an answer was written, and info when the reply changed nothing (`stale`).
 */
function answered(
	c: Context<App>,
	model: FirstPageModel,
	message: string,
	type: "success" | "info" = "success",
) {
	if (!c.req.header("HX-Request")) return c.redirect("/setup", 303);
	return c.html(drawQuestionScreen(model, { focus: true }), 200, {
		"HX-Trigger": hxTrigger({
			toast: { message, type },
			announce: message,
		}),
	});
}

/**
 * The reply to an answer that changed nothing: its merchant has nothing left to ask, or a competing answer got there
 * first. It writes nothing, so the screen is the screen as it is now, and the toast is info, not a success.
 */
function stale(c: Context<App>, model: FirstPageModel) {
	return answered(c, model, "That one is already answered.", "info");
}

/**
 * The GET /first-page address: the questions are asked at /setup now (#773), so a bookmark or a page left open goes there,
 * keeping ?budgets=one when it asked for one at a time.
 */
firstPage.get("/first-page", (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	return c.redirect(
		c.req.query("budgets") === "one" ? "/setup?budgets=one" : "/setup",
		303,
	);
});

/**
 * A POST to the old question page's answers, from a page left open before the questions moved to /setup: nothing is written,
 * and the family is sent to setup (HX-Redirect for htmx, which would otherwise swap the page it doesn't have).
 */
function movedToSetup(c: Context<App>) {
	if (c.req.header("HX-Request")) {
		c.header("HX-Redirect", "/setup");
		return c.body(null, 204);
	}
	return c.redirect("/setup", 303);
}
for (const path of [
	"/first-page/pay",
	"/first-page/bills",
	"/first-page/budgets",
	"/first-page/savings",
]) {
	firstPage.post(path, (c) =>
		c.env.DEMO === "true" ? c.notFound() : movedToSetup(c),
	);
}

/**
 * A pay answer covers only the deposits the question showed: its `deposit` fields, each checked against the merchant's
 * deposits now (payShown here, and again inside answerPay's batch). When one is new or changed since the screen drew,
 * nothing is written and the question is drawn again.
 */
firstPage.post("/setup/pay", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB))) return notOpen(c);
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
	// Nothing left to ask about this merchant: the screen as it is now, and nothing written.
	if (!merchant) return stale(c, await settleAndLoad(c.env.DB, today));
	if (!payShown(merchant, shown)) return payChanged(c, before, merchant.name);
	const hadYesLine = before.ledger.some(
		(line) => line.id === `pay:${merchant.key}`,
	);
	const written = await answerPay(c.env.DB, merchant, answer, actor(c));
	// The re-read is fresh, since `before` may be stale by now. With 0 rows written, a shown deposit still asked about
	// means a sync changed it after the check above, so the question is asked again with payChanged's words. Otherwise a
	// competing answer changed the rows first, and the screen is the screen as it is now (stale).
	const after = await settleAndLoad(c.env.DB, today);
	if (written === 0) {
		return after.pay.some((m) => m.ids.some((id) => merchant.ids.includes(id)))
			? payChanged(c, after, merchant.name)
			: stale(c, after);
	}
	return answered(c, after, paySaved(answer, merchant, hadYesLine));
});

/** The reply when a shown deposit changed since the screen drew: nothing saved, and the question asked again. */
function payChanged(c: Context<App>, model: FirstPageModel, name: string) {
	return answered(
		c,
		model,
		`Nothing saved. The deposits from ${name} changed since the page drew, so the question is asked again below.`,
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

firstPage.post("/setup/bills", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB))) return notOpen(c);
	// Only the charges the form showed are kept: its `keep` fields, each one re-checked against the charges now. An
	// empty form keeps none, and a charge that is new or changed since the screen drew is asked again.
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
		bills.kept === 0 ? "info" : "success",
	);
});

/**
 * The budgets question's answers (spec §8.8, #590). Keep all keeps the suggestions the screen showed, each re-checked as
 * Keep does. One category's Yes keeps its suggestion when the amount is the one the screen showed; another amount is read
 * by the budget sheet's own rule (parseBudgetAmount); a skip keeps the skip. An answer for a category that isn't the first
 * one asked writes nothing, and the first question is asked again (#697). A change since the screen drew is asked again,
 * and a refused amount draws the question again with its error. A form drawn in another household month writes nothing
 * and gets the current month's question. Each answer is one batch with its budget and the stroke.
 */
firstPage.post("/setup/budgets", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	if (!(await readQuestionsGate(c.env.DB))) return notOpen(c);
	const form = await c.req.formData();
	const answer = String(form.get("answer") ?? "");
	if (!["all", "yes", "another", "skip"].includes(answer))
		return c.text("Choose an answer.", 400);
	// Keep all is the only answer to its own question; every other answer is one at a time, so its screen is drawn that way.
	const before = await settleAndLoad(c.env.DB, today, {
		oneAtATime: answer !== "all",
	});
	const step = before.budgets;
	if (!step || step.done) return stale(c, before);
	// A form drawn in another household month writes nothing, since its amounts and 'From <month> on' were for that month.
	if (form.get("month") !== step.month)
		return answered(c, before, budgetsMonthChangedWords(), "info");
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
		// Changed counts what the screen showed and is still asked, and that didn't land: a suggestion that moved, or one that
		// has no suggestion now. A category a Home budget set since is no longer asked, so it is neither kept nor changed.
		const asked = askedIds(after);
		const changed = shownBudgetIds(values).filter(
			(id) => !landed.includes(id) && asked.has(id),
		).length;
		if (landed.length === 0)
			return answered(c, after, keptBudgetsWords(0, changed), "info");
		return answered(c, after, keptBudgetsWords(landed.length, changed));
	}
	const id = Number(form.get("category"));
	const ask = step.asks.find((candidate) => candidate.id === id);
	if (!ask) return stale(c, before);
	// Only the question on the screen is answered. A stale tab's answer for another category writes nothing, and the screen draws
	// that first question again, so a refused amount's error is always the first question's own.
	if (step.asks[0]?.id !== ask.id)
		return answered(c, before, budgetsMovedOnWords(), "info");
	if (answer === "skip") {
		const landed = await keepBudgetAnswers(c.env.DB, today, step.firstDate, [
			{ ask, answer: { kind: "skipped", cents: null } },
		]);
		const after = await settleAndLoad(c.env.DB, today, { oneAtATime: true });
		if (landed.length === 0) return budgetNotSaved(c, after, ask);
		return answered(c, after, skippedBudgetWords(ask.name));
	}
	let kind: "suggested" | "another";
	let cents: number;
	if (answer === "yes") {
		const suggestion = ask.suggestion;
		// The amount the screen showed is the one kept; a suggestion that moved since is asked again.
		if (!suggestion || Number(form.get("shown")) !== suggestion.amountCents)
			return answered(c, before, budgetChangedWords(ask.name), "info");
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
	return answered(c, after, savedBudgetWords(ask.name, cents));
});

/**
 * The savings question's answers (spec §8.8, decision 135, #721). Save it keeps the goal from this month on, with its line;
 * Not now keeps "skipped" and writes no line. The question is checked before anything draws the screen, so a goal Home set
 * after the screen drew is the answer's competitor, not a copy the page already made. A pay or bills question back on the
 * page is asked first, so an answer while one shows gets the screen as it is now. Then one batch: the record's answer
 * (it lands only while the question is open), the goal (only when that landed and no goal above $0 is set), and the
 * budgets stroke. A goal Home set wins over either answer: the record keeps its amount, and the reply says so.
 */
firstPage.post("/setup/savings", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const db = c.env.DB;
	const today = await householdToday(db);
	if (!(await readQuestionsGate(db))) return notOpen(c);
	const form = await c.req.formData();
	const answer = String(form.get("answer") ?? "");
	if (answer !== "save" && answer !== "skip")
		return c.text("Choose an answer.", 400);
	const month = today.slice(0, 7);
	// A question already answered, or a pay or bills question back on the page, gets the screen as it is now, with nothing
	// written. A category added since the screen drew is caught by the write below, which then says so.
	if (!(await budgetsStepShown(db, today)) || !(await savingsOpen(db)))
		return stale(c, await settleAndLoad(db, today));
	// A form drawn in another household month writes nothing, as the budgets question's does.
	if (form.get("month") !== month)
		return answered(
			c,
			await settleAndLoad(db, today),
			budgetsMonthChangedWords(),
			"info",
		);
	const typed = String(form.get("goal") ?? "");
	let cents = 0;
	if (answer === "save") {
		// A blank amount is checked before parseBudgetAmount, which reads it as a bad amount; $0 is no goal.
		if (typed.trim() === "")
			return savingsRefused(c, db, today, SAVINGS_BLANK_WORDS, typed);
		const parsed = parseBudgetAmount(typed);
		if (!parsed.ok) return savingsRefused(c, db, today, parsed.error, typed);
		if (parsed.cents === 0)
			return savingsRefused(c, db, today, SAVINGS_BLANK_WORDS, typed);
		cents = parsed.cents;
	}
	// The goal is written only after the answer landed (changes() > 0 is the answer's own write), and only when no goal above
	// $0 is set, so a goal Home set keeps its amount.
	const results = await db.batch([
		savingsAnswerStatement(db, month, answer === "save" ? cents : "skipped"),
		...(answer === "save"
			? [
					savingsGoalStatement(
						db,
						cents,
						month,
						`changes() > 0 AND ${currentGoalSql(month)} IS NULL`,
					),
				]
			: []),
		strokeStatement(db, "budgets", today, budgetsStrokeGuard(month)),
	]);
	const after = await settleAndLoad(db, today);
	if ((results[0]?.meta.changes ?? 0) === 0)
		// Nothing was saved: a category added since the screen drew asks its budget again, otherwise the screen is as it is now.
		return askedIds(after).size > 0
			? answered(c, after, budgetsMovedOnWords(), "info")
			: stale(c, after);
	// The goal kept when it isn't the amount typed (or any amount, for Not now): Home's goal won over the answer.
	const kept = (await readFirstTally(db))?.savings;
	const homeGoal =
		typeof kept === "number" && (answer === "skip" || kept !== cents)
			? kept
			: null;
	const message =
		homeGoal !== null
			? homeSavingsWords(homeGoal)
			: answer === "save"
				? savedSavingsWords(cents)
				: SKIPPED_SAVINGS_WORDS;
	return answered(c, after, message, homeGoal !== null ? "info" : "success");
});

/**
 * A refused Save it: nothing is saved, and the question is drawn again with its error, the field holding what was typed.
 * htmx swaps it in with a toast; without JavaScript the whole page comes back at 422, as a refused budget's does. A goal
 * Home set after the screen drew settles the step first, so the question is no longer open: that reply is the finished
 * screen with Home's words, not the refusal (#721). A category asked since the screen drew means the savings question isn't
 * the one on the screen: that reply is the moved-on words, not the refusal (#721).
 */
async function savingsRefused(
	c: Context<App>,
	db: D1Database,
	today: string,
	error: string,
	typed: string,
) {
	const model = await settleAndLoad(db, today);
	if (!(await savingsOpen(db))) {
		const kept = (await readFirstTally(db))?.savings;
		return typeof kept === "number"
			? answered(c, model, homeSavingsWords(kept), "info")
			: stale(c, model);
	}
	if (askedIds(model).size > 0)
		return answered(c, model, budgetsMovedOnWords(), "info");
	const savingsError = { text: error, typed };
	if (!c.req.header("HX-Request"))
		return c.html(questionsPage(model, true, null, savingsError), 422);
	return c.html(drawQuestionScreen(model, { focus: true, savingsError }), 422, {
		"HX-Trigger": hxTrigger({
			toast: { message: error, type: "error" },
			announce: error,
		}),
	});
}

/** The categories the budgets step still asks, by id: none once the step is done. */
function askedIds(model: FirstPageModel): Set<number> {
	return new Set(
		model.budgets && !model.budgets.done
			? model.budgets.asks.map((ask) => ask.id)
			: [],
	);
}

/**
 * The reply to a budget answer that saved nothing. Its category is still asked when its suggestion moved since the screen
 * drew, so it is asked again with that said. Otherwise a Home budget or a competing answer got there first (stale).
 */
function budgetNotSaved(
	c: Context<App>,
	model: FirstPageModel,
	ask: BudgetAsk,
) {
	return askedIds(model).has(ask.id)
		? answered(c, model, budgetChangedWords(ask.name), "info")
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
		return c.html(questionsPage(model, true, budgetError, null), 422);
	return c.html(drawQuestionScreen(model, { focus: true, budgetError }), 422, {
		"HX-Trigger": hxTrigger({
			toast: { message: error, type: "error" },
			announce: error,
		}),
	});
}

import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { parseBudgetAmount } from "../budgets/amount";
import { householdToday } from "../dates";
import {
	type PayAnswer,
	readFirstTally,
	strokeStatement,
} from "../db/first-tally";
import { currentGoalSql, savingsGoalStatement } from "../db/savings-goals";
import { readAtEdge } from "../edge";
import { RowId, WholeCentsText } from "../edge-kinds";
import { keepHeading, keepReply } from "../first-tally/bills";
import {
	askHeading,
	type BudgetAsk,
	budgetChangedWords,
	budgetsMovedOnWords,
	homeSavingsWords,
	keepAllQuestion,
	keptBudgetsWords,
	SAVINGS_BLANK_WORDS,
	SKIPPED_SAVINGS_WORDS,
	savedBudgetWords,
	savedSavingsWords,
	shownBudgetIds,
	skippedBudgetWords,
} from "../first-tally/budgets";
import { FINISH_HEADING } from "../first-tally/finish";
import {
	answerPay,
	budgetsStepShown,
	budgetsStrokeGuard,
	type FinishRead,
	type FirstPageModel,
	isSavedCents,
	keepBills,
	keepBudgetAnswers,
	type PayMerchant,
	savingsAnswerStatement,
	savingsOpen,
	settleAndLoad,
} from "../first-tally/first-page";
import { readQuestionsGate } from "../first-tally/gate";
import { skippedNotes } from "../first-tally/skipped";
import { hxTrigger } from "../htmx";
import {
	answerOneBudget,
	answerPay as answerPayRule,
	answerSavings,
	keepAllBudgets,
	keepFoundBills,
	type QuestionsNotOpen,
} from "../rules/setup";
import { type Decided, decided } from "../rules/terms";
import { Layout } from "../views/layout";
import { SetupFinish } from "../views/setup-finish";
import {
	type BudgetError,
	SetupBills,
	SetupBudgets,
	SetupOneBudget,
	SetupPay,
	SetupSavings,
} from "../views/setup-questions";

// The setup questions' answers (P142 A, spec §8.8, decision 148, #773): the questions are asked at /setup, one screen at a
// time, and each answer is a POST here that writes it and swaps the screen (#setup-screen). Without JavaScript the answer
// redirects back to /setup. /first-page, the question page this replaced, now sends a family to /setup.

type App = { Bindings: Env; Variables: { actor: string } };

// The answer words a question's form posts, read at the edge (decision 206). A word not on the list is refused by the route
// with its own sentence, as before; the rule takes only a word on the list.
const YesOrNo = Schema.Literals(["yes", "no"]);
const BudgetAnswerWord = Schema.Literals(["all", "yes", "another", "skip"]);
const SavingsAnswerWord = Schema.Literals(["save", "skip"]);

export const firstPage = new Hono<App>();

/** True when a rule refused because the setup questions are not open. */
const isNotOpen = <W, E extends { _tag: string }>(
	answer: Decided<W, E>,
): answer is { kind: "refuse"; refusal: E & QuestionsNotOpen } =>
	answer.kind === "refuse" &&
	Predicate.isTagged(answer.refusal, "QuestionsNotOpen");

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
 * The question screen a model draws (P142 A, #773): the setup finish once the budgets stroke is drawn (model.finish, read from
 * the record, so it comes before any question, #774), then the pay question while a merchant is left, then the bills question
 * while charges are kept, then the budgets step: with no category left to ask it is the savings question; keep all while it is
 * the one asked, else one category. `focus` moves the focus to the screen's heading (a refused amount's field takes it
 * instead), and the check-in follows the model's `watching`.
 */
export function questionScreen(
	model: FirstPageModel,
	{ focus, budgetError = null, savingsError = null }: ScreenOptions,
) {
	if (model.finish) return <SetupFinish {...model.finish} focus={focus} />;
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
	// The type allows null, and the page has no screen to draw then. A drawn step is the finish above, so it draws none here.
	if (!budgets || budgets.done) return null;

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
 * The heading the question screen draws (its h1), or null for a page with no screen (the finish's heading when the finish is
 * drawn). The in-place redraw announces it, so the words here are the screen's own.
 */
export function questionHeading(model: FirstPageModel): string | null {
	if (model.finish) return FINISH_HEADING;

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
 * The setup finish as a whole page (GET /setup once the budgets stroke is drawn, read by readFinish): the setup layout around
 * the finish, as questionsPage lays out a question screen. `focus` moves the focus to its heading.
 */
export function finishPage(finish: FinishRead, focus: boolean) {
	return (
		<Layout setup title="Setup · Tally" demo={false} currentPath="/setup">
			<SetupFinish {...finish} focus={focus} />
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
	// The page is read only while the questions are open: reading it settles the steps that ask nothing.
	const open = await readQuestionsGate(c.env.DB);
	const form = await c.req.formData();
	const key = String(form.get("merchant") ?? "");
	const answer = readAtEdge(YesOrNo, String(form.get("answer") ?? ""));

	const shown = form
		.getAll("deposit")
		.filter((value): value is string => typeof value === "string");

	if (open && !answer.ok) return c.text("Choose yes or no.", 400);
	const before = open ? await settleAndLoad(c.env.DB, today) : null;

	const asked = decided(
		answerPayRule.decide(
			{
				merchantKey: key,
				// A closed gate refuses the answer whatever it is, so a word not on the list reads as the old coercion did: Yes.
				answer: answer.ok ? answer.value : "yes",
				shown,
				who: actor(c),
			},
			{ open, merchant: before?.pay.find((m) => m.key === key) ?? null },
		),
	);

	if (before === null || isNotOpen(asked)) return notOpen(c);

	// Nothing left to ask about this merchant: the screen as it is now, and nothing written.
	if (asked.kind === "nothingToDo")
		return stale(c, await settleAndLoad(c.env.DB, today));

	if (asked.kind === "refuse")
		return payChanged(
			c,
			before,
			before.pay.find((m) => m.key === key)?.name ?? "",
		);

	const { merchant } = asked.save;

	const hadYesLine = before.ledger.some(
		(line) => line.id === `pay:${merchant.key}`,
	);

	const written = await answerPay(
		c.env.DB,
		merchant,
		asked.save.answer,
		asked.save.who,
	);

	// The re-read is fresh, since `before` may be stale by now. With 0 rows written, a shown deposit still asked about
	// means a sync changed it after the check above, so the question is asked again with payChanged's words. Otherwise a
	// competing answer changed the rows first, and the screen is the screen as it is now (stale).
	const after = await settleAndLoad(c.env.DB, today);

	if (written === 0) {
		return after.pay.some((m) => m.ids.some((id) => merchant.ids.includes(id)))
			? payChanged(c, after, merchant.name)
			: stale(c, after);
	}

	return answered(c, after, paySaved(asked.save.answer, merchant, hadYesLine));
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
	const open = await readQuestionsGate(c.env.DB);

	// Only the charges the form showed are kept: its `keep` fields, each one re-checked against the charges now. An
	// empty form keeps none, and a charge that is new or changed since the screen drew is asked again.
	const values = (await c.req.formData())
		.getAll("keep")
		.filter((value): value is string => typeof value === "string");

	const before = open ? await settleAndLoad(c.env.DB, today) : null;

	const asked = decided(
		keepFoundBills.decide(
			{ shown: values },
			{ open, keep: before?.keep ?? [] },
		),
	);

	if (asked.kind !== "write") return notOpen(c);
	const bills = await keepBills(c.env.DB, today, asked.save.keep);
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
	const open = await readQuestionsGate(c.env.DB);

	if (!open) return notOpen(c);
	const form = await c.req.formData();
	const word = readAtEdge(BudgetAnswerWord, String(form.get("answer") ?? ""));

	if (!word.ok) return c.text("Choose an answer.", 400);
	const answer = word.value;

	// Keep all is the only answer to its own question; every other answer is one at a time, so its screen is drawn that way.
	const before = await settleAndLoad(c.env.DB, today, {
		oneAtATime: answer !== "all",
	});

	const step = before.budgets && !before.budgets.done ? before.budgets : null;
	const month = String(form.get("month") ?? "");

	if (answer === "all") {
		const values = form
			.getAll("keep")
			.filter((value): value is string => typeof value === "string");

		const asked = decided(
			keepAllBudgets.decide({ month, shown: values }, { open, step }),
		);

		if (asked.kind === "nothingToDo") return stale(c, before);

		// A form drawn in another household month writes nothing, since its amounts and 'From <month> on' were for that month.
		if (asked.kind === "refuse")
			return answered(c, before, asked.refusal.say, "info");

		const writes = asked.save.answers;

		const landed =
			writes.length === 0
				? []
				: await keepBudgetAnswers(
						c.env.DB,
						today,
						asked.save.firstDate,
						writes,
					);

		const after =
			writes.length === 0 ? before : await settleAndLoad(c.env.DB, today);

		// Changed counts what the screen showed and is still asked, and that didn't land: a suggestion that moved, or one that
		// has no suggestion now. A category a Home budget set since is no longer asked, so it is neither kept nor changed.
		const stillAsked = askedIds(after);

		const changed = shownBudgetIds(values).filter(
			(id) => !landed.includes(id) && stillAsked.has(id),
		).length;

		if (landed.length === 0)
			return answered(c, after, keptBudgetsWords(0, changed), "info");

		return answered(c, after, keptBudgetsWords(landed.length, changed));
	}

	// The category id and the shown price are digits the form wrote (RowId, WholeCentsText). A refused one is 0: no category
	// has id 0, and no suggestion is 0 (firstBudgetSuggestion gives none for a total of $0 or less), so the rule answers it
	// as it answered NaN, since both are only compared with ===.
	const category = readAtEdge(RowId, String(form.get("category") ?? ""));
	const categoryId = category.ok ? category.value : 0;
	const shown = readAtEdge(WholeCentsText, String(form.get("shown") ?? ""));
	const shownCents = shown.ok ? shown.value : 0;

	const typed = String(form.get("budget") ?? "");
	const parsed = parseBudgetAmount(typed);

	const asked = decided(
		answerOneBudget.decide(
			{
				month,
				categoryId,
				answer:
					answer === "skip"
						? { kind: "skip" }
						: answer === "yes"
							? { kind: "yes", shownCents }
							: {
									kind: "another",
									typed: parsed.ok
										? { cents: parsed.cents }
										: { error: parsed.error },
								},
			},
			{ open, step },
		),
	);

	if (asked.kind === "nothingToDo") return stale(c, before);

	if (asked.kind === "refuse") {
		const { refusal } = asked;

		// A refused amount draws the question again with the edge's own error on its field.
		if (Predicate.isTagged(refusal, "AmountRefused"))
			return budgetRefused(
				c,
				before,
				parsed.ok ? refusal.say : parsed.error,
				typed,
			);

		// The page names the category whose suggestion moved since it drew.
		const name = step?.asks.find((ask) => ask.id === categoryId)?.name;

		return answered(
			c,
			before,
			Predicate.isTagged(refusal, "BudgetSuggestionChanged") && name
				? budgetChangedWords(name)
				: refusal.say,
			"info",
		);
	}

	const [kept] = asked.save.answers;

	if (!kept) return stale(c, before);

	const landed = await keepBudgetAnswers(
		c.env.DB,
		today,
		asked.save.firstDate,
		asked.save.answers,
	);

	const after = await settleAndLoad(c.env.DB, today, { oneAtATime: true });

	if (landed.length === 0) return budgetNotSaved(c, after, kept.ask);

	return answered(
		c,
		after,
		kept.answer.cents === null
			? skippedBudgetWords(kept.ask.name)
			: savedBudgetWords(kept.ask.name, kept.answer.cents),
	);
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

	const open = await readQuestionsGate(db);

	if (!open) return notOpen(c);
	const form = await c.req.formData();
	const word = readAtEdge(SavingsAnswerWord, String(form.get("answer") ?? ""));

	if (!word.ok) return c.text("Choose an answer.", 400);
	const answer = word.value;
	const month = today.slice(0, 7);
	const typed = String(form.get("goal") ?? "");
	// A blank amount is read before parseBudgetAmount, which reads it as a bad amount; $0 is no goal.
	const parsed = parseBudgetAmount(typed);

	const blankOrBad =
		typed.trim() === "" || (parsed.ok && parsed.cents === 0)
			? SAVINGS_BLANK_WORDS
			: parsed.ok
				? null
				: parsed.error;

	const asked = decided(
		answerSavings.decide(
			{
				formMonth: String(form.get("month") ?? ""),
				month,
				answer:
					answer === "skip"
						? { kind: "skip" }
						: {
								kind: "save",
								typed:
									parsed.ok && blankOrBad === null
										? { cents: parsed.cents }
										: { error: blankOrBad ?? "" },
							},
			},
			{
				open,
				// A question already answered, or a pay or bills question back on the page. A category added since the
				// screen drew is caught by the write below, which then says so.
				asked: (await budgetsStepShown(db, today)) && (await savingsOpen(db)),
			},
		),
	);

	if (asked.kind === "nothingToDo")
		return stale(c, await settleAndLoad(db, today));

	if (asked.kind === "refuse") {
		// A refused Save it draws the question again with its error.
		if (Predicate.isTagged(asked.refusal, "AmountRefused"))
			return savingsRefused(c, db, today, blankOrBad ?? "", typed);

		// A form drawn in another household month writes nothing, as the budgets question's does.
		return answered(
			c,
			await settleAndLoad(db, today),
			asked.refusal.say,
			"info",
		);
	}

	const cents = asked.save.goal === "skipped" ? 0 : asked.save.goal;

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
		isSavedCents(kept) && (answer === "skip" || kept !== cents) ? kept : null;

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

		return isSavedCents(kept)
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

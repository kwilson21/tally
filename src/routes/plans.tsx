import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { householdToday, monthName, monthsBefore, shortDay } from "../dates";
import {
	holdPlanDelete,
	insertPlan,
	linkPlanPayment,
	loadPlan,
	movePlanToMonth,
	PLAN_UNDO_MS,
	type PlanFields,
	type PlannedExpense,
	paysBillOrPlan,
	planPaymentCandidates,
	restorePlanDelete,
	unlinkPlanPayment,
	updatePlan,
} from "../db/planned-expenses";
import { centsToAmount, formatCents, toCents } from "../money";
import { sheetAttrs } from "../views/bottom-sheet";
import { Button } from "../views/button";
import { Layout } from "../views/layout";
import {
	type PlanMonthOption,
	PlanPaymentPicker,
	PlanSheet,
	type PlanValues,
} from "../views/planned-expense";
import { page as billsPage } from "./bills";

type App = { Bindings: Env };
export const plans = new Hono<App>();

/** The months a plan can be set aside in: this month and the next eleven, plus the plan's own month when earlier. */
function monthOptions(current: string, own?: string): PlanMonthOption[] {
	const start = own && own < current ? own : current;
	const end = monthsBefore(current, -11);
	const options: PlanMonthOption[] = [];
	for (let month = start; month <= end; month = monthsBefore(month, -1)) {
		options.push({
			value: month,
			label: `${monthName(month)} ${month.slice(0, 4)}`,
		});
	}
	return options;
}

/**
 * Sets the toast on a Bills response, and its announcement (which defaults to the toast's words). A header value must be
 * ASCII, so a non-ASCII character in a plan's name (a curly apostrophe) is written as \uXXXX, which the toast's JSON reads back.
 */
function withToast(
	response: Response,
	toast: Record<string, unknown> & { message: string },
	announce = toast.message,
) {
	const json = JSON.stringify({ toast, announce }).replace(
		/[\u007f-\uffff]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	response.headers.set("HX-Trigger", json);
	return response;
}

/** Bills' page as a plan's answer, whose address is Bills' (as a bill's answer sets it, #87). */
function atBills(response: Response) {
	response.headers.set("HX-Push-Url", "/bills");
	return response;
}

/** Bills' page with a plan's sheet over it. */
async function sheetPage(
	c: Context<App>,
	options: {
		plan?: PlannedExpense;
		values?: PlanValues;
		errors?: Record<string, string>;
		deleteConfirm?: boolean;
		/** Opened from the plan's own page, so the sheet closes back there (`opener=plan`). */
		opener?: boolean;
	},
	today: string,
) {
	const month = today.slice(0, 7);
	const { plan, errors = {}, deleteConfirm = false, opener = false } = options;
	const values: PlanValues =
		options.values ??
		(plan
			? {
					name: plan.name,
					amount: centsToAmount(plan.amountCents),
					month: plan.month,
				}
			: { name: "", amount: "", month });
	const paidBy =
		plan?.transactionId && plan.paidDate && plan.paidAmountCents != null
			? {
					name: plan.paidName ?? "Payment",
					date: shortDay(plan.paidDate, today),
					amountCents: plan.paidAmountCents,
				}
			: undefined;
	return billsPage(
		c,
		{
			plan: (
				<PlanSheet
					plan={plan}
					values={values}
					months={monthOptions(month, plan?.month)}
					errors={errors}
					paidBy={paidBy}
					deleteConfirm={deleteConfirm}
					opener={opener}
				/>
			),
		},
		today,
	);
}

/**
 * The fields a plan's sheet sends, checked before the write: a name, an amount above $0, and a month on offer. `own` is
 * the plan's own month when it is being saved: an earlier one stays on offer, as it is on its sheet. A new plan has none,
 * so only this month to the next eleven can be chosen.
 */
function planForm(form: Record<string, unknown>, month: string, own?: string) {
	const values: PlanValues = {
		name: String(form.name ?? "").trim(),
		amount: String(form.amount ?? "").trim(),
		month: String(form.month ?? "").trim(),
	};
	const errors: Record<string, string> = {};
	if (!values.name) errors.name = "Say what it's for.";
	let amountCents = 0;
	try {
		amountCents = toCents(values.amount);
		if (amountCents <= 0) throw new Error("not above zero");
	} catch {
		errors.amount = "Enter an amount greater than $0.";
	}
	const offered = monthOptions(month, own).some(
		(option) => option.value === values.month,
	);
	if (!offered) errors.month = "Choose a month.";
	return {
		values,
		errors,
		fields: {
			name: values.name,
			amountCents,
			month: values.month,
		} satisfies PlanFields,
	};
}

// Specific paths first: /plans/new and /plans/undo-delete are not plan ids.
plans.get("/plans/new", async (c) => {
	const today = await householdToday(c.env.DB);
	return sheetPage(
		c,
		{ values: { name: "", amount: "", month: today.slice(0, 7) } },
		today,
	);
});

plans.post("/plans", async (c) => {
	const today = await householdToday(c.env.DB);
	const { values, errors, fields } = planForm(
		await c.req.parseBody(),
		today.slice(0, 7),
	);
	if (Object.keys(errors).length > 0)
		return sheetPage(c, { values, errors }, today);
	await insertPlan(c.env.DB, fields, actor(c));
	if (!c.req.header("HX-Request")) return c.redirect("/bills", 303);
	return withToast(atBills(await billsPage(c, undefined, today)), {
		message: `Planned ${fields.name}, ${formatCents(fields.amountCents)}.`,
		type: "success",
	});
});

plans.post("/plans/undo-delete", async (c) => {
	const form = await c.req.parseBody();
	const token = typeof form.token === "string" ? form.token : undefined;
	const restored =
		token && /^[0-9a-f-]{36}$/i.test(token)
			? await restorePlanDelete(c.env.DB, token)
			: null;
	const today = await householdToday(c.env.DB);
	if (!c.req.header("HX-Request")) return c.redirect("/bills", 303);
	// Every answer ends the Undo toast it answers, so undoDone names its token (toast.js).
	return withToast(
		atBills(await billsPage(c, undefined, today)),
		restored
			? {
					message: `Restored ${restored.name}.${restored.unlinked ? " Its payment is no longer linked." : ""}`,
					type: "success",
					undoDone: token,
				}
			: {
					message: "Undo expired. The planned expense stays deleted.",
					type: "error",
					undoDone: token,
				},
	);
});

plans.get("/plans/:id/edit", async (c) => {
	const plan = await loadPlan(c.env.DB, Number(c.req.param("id")));
	if (!plan) return c.notFound();
	return sheetPage(
		c,
		{ plan, opener: c.req.query("opener") === "plan" },
		await householdToday(c.env.DB),
	);
});

plans.get("/plans/:id/delete", async (c) => {
	const plan = await loadPlan(c.env.DB, Number(c.req.param("id")));
	if (!plan) return c.notFound();
	return sheetPage(
		c,
		{
			plan,
			deleteConfirm: true,
			opener: c.req.query("opener") === "plan",
		},
		await householdToday(c.env.DB),
	);
});

/**
 * A plan's own page, where its payment is linked (P101). `focusEditPlan` and `focusLinkHeading` take focus when the page is
 * drawn: Edit planned expense after its sheet's save, the Link a payment heading after an Unlink that changed nothing (#87).
 */
async function planPage(
	c: Context<App>,
	id: number,
	error?: string,
	focusEditPlan = false,
	focusLinkHeading = false,
) {
	const plan = await loadPlan(c.env.DB, id);
	if (!plan) return c.notFound();
	const today = await householdToday(c.env.DB);
	const candidates = plan.transactionId
		? []
		: await planPaymentCandidates(c.env.DB, plan);
	return c.html(
		<Layout
			title={`${plan.name} · Tally`}
			active="bills"
			demo={c.env.DEMO === "true"}
			currentPath={c.req.path}
		>
			<div class="max-w-2xl">
				<a href="/bills" class="inline-flex min-h-11 items-center text-accent">
					Bills
				</a>
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					{plan.name}
				</h1>
				<p class="text-lg">
					{formatCents(plan.amountCents)} ·{" "}
					{plan.transactionId
						? `Paid ${shortDay(plan.paidDate ?? today, today)}`
						: `Set aside for ${monthName(plan.month)}`}
				</p>
				{plan.transactionId ? (
					<form
						method="post"
						action={`/plans/${plan.id}/unlink`}
						hx-post={`/plans/${plan.id}/unlink`}
						hx-target="body"
						hx-swap="outerHTML"
						class="mt-6 flex items-center justify-between gap-3 border-t border-rule pt-4"
					>
						<input type="hidden" name="from" value="plan" />
						<p>
							Paid by {plan.paidName} ·{" "}
							{shortDay(plan.paidDate ?? today, today)} ·{" "}
							{formatCents(plan.paidAmountCents ?? 0)}
						</p>
						<Button kind="secondary" type="submit">
							Unlink
						</Button>
					</form>
				) : (
					<PlanPaymentPicker
						planId={plan.id}
						name={plan.name}
						amountCents={plan.amountCents}
						error={error}
						focusHeading={focusLinkHeading}
						candidates={candidates.map((candidate) => ({
							id: candidate.id,
							date: candidate.date,
							dateLabel: shortDay(candidate.date, today),
							amountCents: candidate.amountCents,
							displayName: candidate.displayName,
							excluded: candidate.excluded,
						}))}
					/>
				)}
				<div class="mt-3">
					<Button
						id="edit-plan"
						kind="secondary"
						href={`/plans/${plan.id}/edit?opener=plan`}
						autofocus={focusEditPlan || c.req.query("focus") === "edit-plan"}
						{...sheetAttrs(`/plans/${plan.id}/edit?opener=plan`)}
					>
						Edit planned expense
					</Button>
				</div>
				<div id="sheet" />
			</div>
		</Layout>,
	);
}

plans.get("/plans/:id", (c) => planPage(c, Number(c.req.param("id"))));

plans.post("/plans/:id/link", async (c) => {
	const id = Number(c.req.param("id"));
	const plan = await loadPlan(c.env.DB, id);
	if (!plan) return c.notFound();
	const transaction = Number((await c.req.parseBody()).transaction_id);
	const linked =
		Number.isInteger(transaction) &&
		transaction > 0 &&
		(await linkPlanPayment(c.env.DB, id, transaction));
	if (!c.req.header("HX-Request")) return c.redirect(`/plans/${id}`, 303);
	// Linking stays on the plan's page, which now shows it paid (decision 101), as the bill page's link does.
	if (linked)
		return withToast(await planPage(c, id), {
			message: "Payment linked",
			type: "success",
		});
	// The refusal names what the payment already pays, in the bill side's words (decision 82).
	const paid = Number.isInteger(transaction)
		? await paysBillOrPlan(c.env.DB, transaction)
		: null;
	if (paid === "bill")
		return planPage(c, id, "That payment already pays a bill.");
	if (paid === "plan")
		return planPage(c, id, "That payment already pays a planned expense.");
	return planPage(
		c,
		id,
		`That payment can't be linked. It may already pay a bill or a planned expense.`,
	);
});

plans.post("/plans/:id/unlink", async (c) => {
	const id = Number(c.req.param("id"));
	const plan = await loadPlan(c.env.DB, id);
	if (!plan) return c.notFound();
	// The plan's own page and its sheet both unlink, and each answers with the view it came from (decision 101), as Link does.
	const form = await c.req.parseBody();
	const onPage = form.from === "plan";
	// The sheet's own form carries the opener, so its redrawn sheet still closes to the plan's page.
	const opener = form.opener === "plan";
	const unlinked = await unlinkPlanPayment(c.env.DB, id);
	const today = await householdToday(c.env.DB);
	if (!c.req.header("HX-Request"))
		return c.redirect(onPage ? `/plans/${id}` : "/bills", 303);
	const toast = { message: "Payment unlinked", type: "success" };
	// A stale sheet's second Unlink finds the plan unpaid already: the redrawn page shows it, and no toast claims an unlink.
	// With no toast to say so, the page takes focus on its Link a payment heading instead.
	if (onPage) {
		const page = await planPage(c, id, undefined, false, !unlinked);
		return unlinked ? withToast(page, toast) : page;
	}
	// On the sheet, which stays open on the plan, now unpaid.
	const fresh = (await loadPlan(c.env.DB, id)) ?? plan;
	const sheet = await sheetPage(c, { plan: fresh, opener }, today);
	return unlinked ? withToast(sheet, toast) : sheet;
});

plans.post("/plans/:id/move", async (c) => {
	const id = Number(c.req.param("id"));
	const today = await householdToday(c.env.DB);
	const month = today.slice(0, 7);
	const plan = await loadPlan(c.env.DB, id);
	const moved = plan ? await movePlanToMonth(c.env.DB, id, month) : false;
	if (!c.req.header("HX-Request")) return c.redirect("/bills", 303);
	return withToast(
		atBills(await billsPage(c, undefined, today)),
		moved && plan
			? {
					message: `Moved ${plan.name} to ${monthName(month)}.`,
					type: "success",
				}
			: {
					message: "That planned expense is already moved or paid.",
					type: "error",
				},
	);
});

/** Deletes a plan, and offers Undo for ten seconds (decision 101), like a cash entry. */
async function deletePlan(c: Context<App>, verb: "Deleted" | "Dropped") {
	const id = Number(c.req.param("id"));
	const plan = await loadPlan(c.env.DB, id);
	if (!plan) return c.notFound();
	const token = await holdPlanDelete(c.env.DB, id);
	const today = await householdToday(c.env.DB);
	if (!c.req.header("HX-Request")) return c.redirect("/bills", 303);
	const deleted = `${verb} ${plan.name}, ${formatCents(plan.amountCents)}.`;
	const response = atBills(await billsPage(c, undefined, today));
	if (!token) {
		return withToast(response, {
			message: "That planned expense is already gone.",
			type: "error",
		});
	}
	// The announcement names the Undo's window, as the cash delete's does (#342).
	return withToast(
		response,
		{
			message: deleted,
			type: "success",
			undo: token,
			undoExpiresInMs: PLAN_UNDO_MS,
			undoAction: "/plans/undo-delete",
		},
		`${deleted} Undo for 10 seconds.`,
	);
}

plans.post("/plans/:id/delete", (c) => deletePlan(c, "Deleted"));
// The Band's Drop: the answer deletes the plan, through the same Undo as a Delete.
plans.post("/plans/:id/drop", (c) => deletePlan(c, "Dropped"));

plans.post("/plans/:id", async (c) => {
	const id = Number(c.req.param("id"));
	const plan = await loadPlan(c.env.DB, id);
	if (!plan) return c.notFound();
	const today = await householdToday(c.env.DB);
	const form = await c.req.parseBody();
	// A save from the plan's own page (Edit planned expense) answers with that page, as the sheet's close returns there (#87).
	const opener = form.opener === "plan";
	const { values, errors, fields } = planForm(
		form,
		today.slice(0, 7),
		plan.month,
	);
	if (Object.keys(errors).length > 0)
		return sheetPage(c, { plan, values, errors, opener }, today);
	await updatePlan(c.env.DB, id, fields);
	const message = `Saved ${fields.name}.`;
	if (opener) {
		if (!c.req.header("HX-Request"))
			return c.redirect(`/plans/${id}?focus=edit-plan`, 303);
		const page = await planPage(c, id, undefined, true);
		page.headers.set("HX-Push-Url", `/plans/${id}`);
		return withToast(page, { message, type: "success" });
	}
	if (!c.req.header("HX-Request")) return c.redirect("/bills", 303);
	return withToast(atBills(await billsPage(c, undefined, today)), {
		message,
		type: "success",
	});
});

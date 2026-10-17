import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { addressOf } from "../address";
import { askAgainLeftOut, leftOutSentence } from "../categorize-pending";
import { categoryNames, makeCategory, unmakeCategory } from "../db/categories";
import { createFromSuggestion } from "../db/category-suggestions";
import {
	type NewCategorySuggestion,
	newCategoryItem,
} from "../db/suggestions-queue";
import { hxTrigger } from "../htmx";
import { formatCents } from "../money";
import { nameForm, parseCategory } from "../settings/category-form";
import {
	type OrganizeGroup,
	organizeGroups,
	saveOrganizeGroup,
	setOrganizeRule,
	storeOffer,
	storeRowOf,
} from "../transactions/organize";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import {
	NEW_CATEGORY_GROUP,
	NewCategoryChip,
	NewCategoryName,
} from "../views/new-category-choice";
import { GroupRuleOffer, type GroupRuleOfferValue } from "../views/rule-offer";
import { OrganizeNewCategoryCard } from "../views/suggestion-card";
import { TextInput } from "../views/text-input";
import { CHANGED_SUGGESTION } from "./suggestions";

type App = { Bindings: Env };
type Category = { id: number; name: string; icon: string; color: string };
type Values = {
	categoryId: number | null;
	name: string;
	groupName: string;
	/** New category was chosen, with the name typed under the chips. */
	newCategory?: boolean;
	newCategoryName?: string;
	categoryError?: string;
	newCategoryError?: string;
	nameError?: string;
};

/** An answer's reply (#353): the toast and the announcement, sent as one HX-Trigger header. */
type Trigger = {
	toast?: { message: string; type: "success" };
	announce?: string;
};

export const organize = new Hono<App>();

/** The suggestion's other merchants, each counted once: its stores outside this group, by the name each shows (decision 120). */
function otherMerchants(
	suggestion: NewCategorySuggestion,
	group: OrganizeGroup,
): number {
	return new Set(
		suggestion.stores
			.filter((store) => !group.merchantKeys.includes(store.merchantKey))
			.map((store) => store.merchant),
	).size;
}

async function renderOrganize(
	c: Context<App>,
	values?: Values,
	status: 200 | 422 = 200,
	focus = false,
	/** After a save, the question about the rule in place of the store (#353). */
	rule?: GroupRuleOfferValue,
	/**
	 * A rule answer's reply (#353). When it is given, the one HX-Trigger header is set here, and the empty state's sentence
	 * joins the announcement when the list ends on it. Without it, the caller's own header stands.
	 */
	trigger?: Trigger,
	/**
	 * A refused Create's reason, or the words that the suggestion changed (decision 120), with the suggestion they answer. They
	 * sit in its card when that card is drawn, and under Organize's heading when it isn't.
	 */
	cardError?: { suggestionId: number; message: string },
) {
	const params = new URL(c.req.url).searchParams;
	const requestedSkips = params.getAll("skip");
	const [allGroups, categories] = await Promise.all([
		organizeGroups(c.env.DB),
		c.env.DB.prepare(
			"SELECT id, name, icon, color FROM categories WHERE archived = 0 ORDER BY sort_order, name",
		).all<Category>(),
	]);
	const currentNames = new Set(allGroups.map((group) => group.name));
	const skipped = [...new Set(requestedSkips)].filter((name) =>
		currentNames.has(name),
	);
	const available = allGroups.filter((group) => !skipped.includes(group.name));
	const group =
		(values && allGroups.find((item) => item.name === values.groupName)) ||
		available[0];
	// The one waiting suggestion that holds a purchase from this merchant (decision 120), read only when its card is drawn.
	const waiting =
		!rule && group
			? await newCategoryItem(c.env.DB, { merchantKeys: group.merchantKeys })
			: undefined;
	// The changed or refused words sit in the card when that suggestion's card is drawn, and under the heading when it isn't.
	const inCard = !!waiting && cardError?.suggestionId === waiting.suggestionId;
	const remaining = available.reduce((sum, item) => sum + item.count, 0);
	const doneSentence =
		allGroups.length > 0
			? "You skipped the rest."
			: "Every transaction has a category.";
	const query = new URLSearchParams();
	for (const name of skipped) query.append("skip", name);
	const action = `/transactions/organize${query.size ? `?${query}` : ""}`;
	const skipParams = new URLSearchParams(query);
	if (group) skipParams.append("skip", group.name);
	const skipHref = `/transactions/organize?${skipParams}`;
	const sources = group
		? `${group.bankTexts.slice(0, 3).join(", ")}${group.bankTexts.length > 3 ? ` and ${group.bankTexts.length - 3} more` : ""}`
		: "";
	// The question's answers go to the same skips, and Not now or Yes then moves on from them. Only the skips: the
	// question's own address also carries its category and store, which an answer must not repeat.
	const ruleAction = `/transactions/organize/rule${query.size ? `?${query}` : ""}`;
	if (trigger) {
		// The list ends on its empty state only when no store is left, so its sentence is announced after the answer's words.
		const ends = focus && !rule && !group;
		const announce = [trigger.announce, ends && doneSentence]
			.filter(Boolean)
			.join(" ");
		if (trigger.toast || announce)
			c.header(
				"HX-Trigger",
				hxTrigger({
					toast: trigger.toast,
					announce: announce || undefined,
				}),
			);
	}

	return c.html(
		<Layout
			title="Organize · Tally"
			active="transactions"
			demo={c.env.DEMO === "true"}
			currentPath={addressOf(c)}
		>
			<div id="organize-page" class="lg:max-w-3xl">
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					Organize
				</h1>
				{cardError && !inCard && (
					<p role="alert" class="mt-3 text-sm text-over">
						{cardError.message}
					</p>
				)}
				{rule ? (
					<GroupRuleOffer value={rule} action={ruleAction} focus />
				) : group ? (
					<>
						<p class="mt-2 text-muted">
							{skipped.length + 1} of {allGroups.length} · {remaining} left, all
							months
						</p>
						<div class="mt-6">
							<h2
								class="font-serif text-3xl font-semibold"
								tabindex={focus ? -1 : undefined}
								autofocus={focus}
							>
								{group.name}
							</h2>
							<p class="text-muted">
								{group.count}{" "}
								{group.count === 1 ? "transaction" : "transactions"} ·{" "}
								{formatCents(group.totalCents)}
							</p>
							<p class="mt-1 text-sm text-muted">From {sources}</p>
						</div>
						{/* Tally's guess for this merchant sits above the chips (decision 120): its Create files the purchases the card counts. */}
						{waiting && (
							<div class="mt-5">
								<OrganizeNewCategoryCard
									name={waiting.name}
									existing={waiting.existing ?? undefined}
									archived={waiting.archived}
									others={otherMerchants(waiting, group)}
									action={`/transactions/organize/suggestion${query.size ? `?${query}` : ""}`}
									suggestionId={waiting.suggestionId}
									shown={waiting.rows.map((row) => row.transactionId)}
									error={inCard ? cardError?.message : undefined}
								/>
							</div>
						)}
						<form
							method="post"
							action={action}
							hx-post={action}
							hx-disable="#organize-page button[type=submit]"
							hx-sync="#organize-page:drop"
							hx-target="#organize-page"
							hx-select="#organize-page"
							hx-swap="outerHTML"
							hx-push-url={action}
							class="mt-5 flex flex-col gap-4"
						>
							<input type="hidden" name="group" value={group.name} />
							<fieldset
								id="organize-category"
								tabindex={-1}
								class={`flex flex-col gap-2 ${NEW_CATEGORY_GROUP}`}
								aria-describedby={
									values?.categoryError ? "category-error" : undefined
								}
							>
								<legend class="text-base text-ink">Category</legend>
								<div class="flex flex-wrap gap-2">
									{categories.results.map((category) => (
										<Chip
											type="radio"
											name="category"
											value={String(category.id)}
											checked={values?.categoryId === category.id}
											icon={
												<CategoryIcon
													icon={category.icon}
													color={category.color}
												/>
											}
										>
											{category.name}
										</Chip>
									))}
									<NewCategoryChip checked={values?.newCategory === true} />
								</div>
								{/* Opens under the chips while New category is chosen (CSS, decision 101). One
								    charge reads in the singular, a merchant with more in the plural. */}
								<NewCategoryName
									id="new-category-name"
									value={values?.newCategoryName ?? ""}
									hint={`Added to your categories and used for ${group.count === 1 ? "this transaction" : "these transactions"}.`}
									error={values?.newCategoryError}
								/>
								{values?.categoryError && (
									<p id="category-error" role="alert" class="text-sm text-over">
										{values.categoryError}
									</p>
								)}
							</fieldset>
							<TextInput
								id="organize-name"
								name="name"
								label="Name (optional)"
								hint="Change it to rename every transaction from this merchant."
								value={values ? values.name : group.name}
								maxlength={80}
								error={values?.nameError}
								autocomplete="off"
							/>
							<div class="flex items-center gap-3">
								<Button type="submit">Save and next</Button>
								<Button kind="text" href={skipHref}>
									Skip
								</Button>
							</div>
						</form>
					</>
				) : (
					<EmptyState
						kind="done"
						sentence={doneSentence}
						focus={focus}
						action={
							allGroups.length > 0
								? { href: "/transactions/organize", label: "Start over" }
								: undefined
						}
					/>
				)}
			</div>
		</Layout>,
		status,
	);
}

/**
 * The address of Organize's question for a store (#353, #532): the skips the page carries, then the category and the
 * store's merchant row number. The question has an address of its own, so a reload asks it again, and the address is the
 * same length however many charges the store has.
 */
function questionAddress(
	skips: string[],
	categoryId: number,
	storeRow: number,
): string {
	const params = new URLSearchParams([
		...skips.map((name): [string, string] => ["skip", name]),
		["category", String(categoryId)],
		["store", String(storeRow)],
	]);
	return `/transactions/organize?${params}`;
}

/**
 * Organize's page. A Save that asks the question lands on the question's own address both ways (#353): by a 303
 * redirect with JavaScript off, and by the reply's HX-Push-Url with it. The address names the store and the category
 * (#532), and storeOffer rebuilds the question from them. Anything else in those parameters, or a question the charges
 * no longer hold, shows the ordinary page. An address from before #532, which carried the saved ids, shows the ordinary
 * page too.
 */
organize.get("/transactions/organize", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const offer = await storeOffer(
		c.env.DB,
		Number(params.get("store")),
		Number(params.get("category")),
	);
	return offer
		? renderOrganize(c, undefined, 200, true, offer)
		: renderOrganize(c);
});

/**
 * Create on Organize's card (decision 120): the same write as Settings' Create, with every purchase the card showed
 * ticked and filed. Create files only what the card showed (`shown`): when the suggestion's purchases no longer match
 * them, it files nothing and says the suggestion changed. Organize stays where it is: its list is drawn again with the
 * next merchant. With JavaScript the words are a toast, and a refused Create's reason shows in the card; without it, the
 * same words are drawn on the page, in the card or under Organize's heading when no card for the suggestion is drawn.
 */
organize.post("/transactions/organize/suggestion", async (c) => {
	const form = await c.req.formData();
	const suggestionId = Number(form.get("suggestion"));
	const url = new URL(c.req.url);
	const next = `/transactions/organize${url.search}`;
	const item =
		Number.isInteger(suggestionId) && suggestionId > 0
			? await newCategoryItem(c.env.DB, { id: suggestionId })
			: undefined;
	// The suggestion changed: a toast with JavaScript, or Organize drawn with the words without it.
	const changed = () => {
		if (c.req.header("HX-Request")) {
			c.header(
				"HX-Trigger",
				hxTrigger({
					toast: { message: CHANGED_SUGGESTION, type: "info" },
					announce: CHANGED_SUGGESTION,
				}),
			);
			return renderOrganize(c, undefined, 200, true);
		}
		return renderOrganize(c, undefined, 200, true, undefined, undefined, {
			suggestionId,
			message: CHANGED_SUGGESTION,
		});
	};
	// A refused Create's reason, drawn on the page for either kind of request.
	const refused = (message: string) =>
		renderOrganize(c, undefined, 422, true, undefined, undefined, {
			suggestionId,
			message,
		});
	if (!item) return changed();
	const ids = item.rows.map((row) => row.transactionId);
	const shown = new Set(
		form
			.getAll("shown")
			.map(Number)
			.filter((n) => Number.isInteger(n) && n > 0),
	);
	if (shown.size !== ids.length || !ids.every((id) => shown.has(id)))
		return changed();
	const result = await createFromSuggestion(
		c.env.DB,
		suggestionId,
		{ ticked: ids, shown: ids, notes: {} },
		actor(c),
	);
	// Organize ticks every purchase the card showed, so "empty" means another tab filed them: the same answer as "gone".
	if (!result.ok) {
		if (result.reason === "gone" || result.reason === "empty") return changed();
		return refused(result.error ?? "That category couldn't be made.");
	}
	await askAgainLeftOut(
		c.env as Env & { JEV_API_KEY?: string },
		result.leftOut,
		(work) => c.executionCtx.waitUntil(work),
	);
	const count = result.moved;
	const transactions = `${count} ${count === 1 ? "transaction" : "transactions"}`;
	const message = result.restored
		? `Restored ${result.name} with ${transactions}`
		: result.attached
			? `Added ${transactions} to ${result.name}`
			: `Created ${result.name} with ${transactions}`;
	const left = leftOutSentence(result.leftOut.length);
	if (!c.req.header("HX-Request")) return c.redirect(next, 303);
	return renderOrganize(c, undefined, 200, true, undefined, {
		toast: { message, type: "success" },
		announce: `${message}.${left ? ` ${left}` : ""}`,
	});
});

organize.post("/transactions/organize", async (c) => {
	const form = await c.req.formData();
	const categoryId = Number(form.get("category"));
	const name = form.get("name")?.toString().trim() ?? "";
	const groupName = form.get("group")?.toString() ?? "";
	const groups = await organizeGroups(c.env.DB);
	const group = groups.find((item) => item.name === groupName);
	const category =
		Number.isInteger(categoryId) && categoryId > 0
			? await c.env.DB.prepare(
					"SELECT id, name FROM categories WHERE id = ? AND archived = 0",
				)
					.bind(categoryId)
					.first<{ id: number; name: string }>()
			: null;
	const url = new URL(c.req.url);
	const next = url.pathname + url.search;
	// Another tab already finished this merchant: show the next one with a fresh form,
	// so the stale choices can't carry over to it.
	const alreadyCategorized = () => {
		if (!c.req.header("HX-Request")) return c.redirect(next, 303);
		const message = "That merchant already has a category.";
		c.header(
			"HX-Trigger",
			hxTrigger({ toast: { message, type: "info" }, announce: message }),
		);
		return renderOrganize(c, undefined, 200, true);
	};
	if (!group) return alreadyCategorized();
	// "New category" (decision 101) is the choice when it's chosen: its name is checked first, and the
	// category is made only once the rest passes, so a taken name saves nothing.
	const choseNew = form.get("category") === "new";
	const named = choseNew
		? parseCategory(
				nameForm(form.get("new_category_name")),
				await categoryNames(c.env.DB),
				null,
			)
		: null;
	const values: Values = {
		categoryId: categoryId || null,
		name,
		groupName,
		newCategory: choseNew,
		newCategoryName: String(form.get("new_category_name") ?? ""),
	};
	if (named && !named.ok) values.newCategoryError = named.errors.name;
	else if (!choseNew && !category)
		values.categoryError = "Pick a category from the list.";
	if (name.length > 80)
		values.nameError = "Name must be 80 characters or fewer.";
	if (values.categoryError || values.newCategoryError || values.nameError)
		return renderOrganize(c, values, 422);

	let chosen = category;
	let madeId: number | null = null;
	if (named?.ok) {
		const made = await makeCategory(c.env.DB, named.value);
		if (!made.ok)
			return renderOrganize(
				c,
				{ ...values, newCategoryError: made.error },
				422,
			);
		chosen = { id: made.id, name: named.value.name };
		madeId = made.id;
	}
	if (!chosen) return renderOrganize(c, values, 422);

	const currentGroup = group;
	const filed = await saveOrganizeGroup(
		c.env.DB,
		currentGroup.merchantKeys,
		chosen.id,
		name && name !== currentGroup.name ? name : null,
		actor(c),
	);
	if (filed.length === 0) {
		// Another request categorized this group after it was read, so nothing was filed: a category made
		// here goes too, and the answer is the one for a merchant that already has a category.
		if (madeId !== null) await unmakeCategory(c.env.DB, madeId);
		return alreadyCategorized();
	}
	const count = filed.length;
	const message = `${count} ${count === 1 ? "transaction" : "transactions"} set to ${chosen.name}.`;
	// The save makes no rule. Organize asks #209's question after it (#353), about the store's charges in the category
	// (#532), rebuilt the way a reload rebuilds it: no question when that rebuild holds none, as when every merchant of
	// the store has the rule already or a trip looks mixed (decision 113).
	const store = await storeRowOf(c.env.DB, filed);
	const offer =
		store === null ? null : await storeOffer(c.env.DB, store, chosen.id);
	// The question has an address of its own (#353), so a reload asks it again.
	const asked = offer
		? questionAddress(url.searchParams.getAll("skip"), chosen.id, offer.store)
		: null;
	if (!c.req.header("HX-Request")) return c.redirect(asked ?? next, 303);
	c.header(
		"HX-Trigger",
		hxTrigger({ toast: { message, type: "success" }, announce: message }),
	);
	if (asked) c.header("HX-Push-Url", asked);
	return renderOrganize(c, undefined, 200, true, offer ?? undefined);
});

/**
 * Not now or Yes on Organize's question (#353). Yes makes the rule on each merchant key of the store's charges in the
 * category (#532): storeOffer rebuilds them from the store and category the form posts, so nothing else in the request
 * counts, and a posted list of ids or a name is ignored. Either answer moves on to the next store, with focus on its name.
 */
organize.post("/transactions/organize/rule", async (c) => {
	const form = await c.req.formData();
	const url = new URL(c.req.url);
	// The skips only: an answer to the question must not carry its category or store back into the question.
	const skips = new URLSearchParams(
		url.searchParams.getAll("skip").map((name) => ["skip", name]),
	);
	const next = `/transactions/organize${skips.size ? `?${skips}` : ""}`;
	const offer =
		form.get("answer") === "yes"
			? await storeOffer(
					c.env.DB,
					Number(form.get("store")),
					Number(form.get("category")),
				)
			: null;
	const written = offer
		? await setOrganizeRule(
				c.env.DB,
				offer.categoryId,
				JSON.stringify(offer.savedIds),
				offer.merchant,
				actor(c),
			)
		: [];
	if (!c.req.header("HX-Request")) return c.redirect(next, 303);
	// Named only when a rule was written: a store whose charges were filed elsewhere meanwhile makes none.
	const trigger: Trigger = {};
	if (offer && written.length > 0) {
		const message = `${offer.merchant} is always ${offer.category} now.`;
		trigger.toast = { message, type: "success" };
		trigger.announce = message;
	}
	// The Save before it pushed the question's address, so the answer replaces it with the skips-only address, giving
	// one history entry, not two.
	c.header("HX-Replace-Url", next);
	return renderOrganize(c, undefined, 200, true, undefined, trigger);
});

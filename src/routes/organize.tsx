import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { categoryNames, makeCategory, unmakeCategory } from "../db/categories";
import { jevSaysMixedAmong } from "../db/mixed-trip";
import { hxTrigger } from "../htmx";
import { formatCents } from "../money";
import { nameForm, parseCategory } from "../settings/category-form";
import {
	groupHasRule,
	organizeGroups,
	organizeOffer,
	saveOrganizeGroup,
	setOrganizeRule,
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
import { TextInput } from "../views/text-input";

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
	// question's own address also carries its category and saved ids, which an answer must not repeat.
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
			currentPath={c.req.path + new URL(c.req.url).search}
		>
			<div id="organize-page" class="lg:max-w-3xl">
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					Organize
				</h1>
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
						<form
							method="post"
							action={action}
							hx-post={action}
							hx-disable="findAll button[type=submit]"
							hx-target="#organize-page"
							hx-select="#organize-page"
							hx-swap="outerHTML"
							hx-push-url={action}
							class="mt-5 flex flex-col gap-4"
						>
							<input type="hidden" name="group" value={group.name} />
							<fieldset
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
 * The address of Organize's question for a saved group (#353): the skips the page carries, then the category and the
 * saved charges' ids joined by dots. The question has an address of its own, so a reload asks it again.
 */
function questionAddress(
	skips: string[],
	categoryId: number,
	savedIds: number[],
): string {
	const params = new URLSearchParams([
		...skips.map((name): [string, string] => ["skip", name]),
		["category", String(categoryId)],
		["saved", savedIds.join(".")],
	]);
	return `/transactions/organize?${params}`;
}

/**
 * Organize's page. A Save that asks the question lands on the question's own address both ways (#353): by a 303
 * redirect with JavaScript off, and by the reply's HX-Push-Url with it. Anything else in those parameters, or a
 * question the charges no longer hold, shows the ordinary page.
 */
organize.get("/transactions/organize", async (c) => {
	const params = new URL(c.req.url).searchParams;
	const categoryId = Number(params.get("category"));
	const savedIds = (params.get("saved") ?? "")
		.split(".")
		.map(Number)
		.filter((id) => Number.isSafeInteger(id) && id > 0);
	const offer =
		Number.isSafeInteger(categoryId) && categoryId > 0 && savedIds.length > 0
			? await organizeOffer(c.env.DB, savedIds, categoryId)
			: null;
	return offer
		? renderOrganize(c, undefined, 200, true, offer)
		: renderOrganize(c);
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
	// The save makes no rule. Organize asks #209's question after it (#353), unless every merchant of the group
	// has this rule already; then it moves on as it always did.
	// No question when a trip it filed looks mixed (decision 113): a rule is never offered across categories.
	const asks =
		!(await groupHasRule(c.env.DB, currentGroup.merchantKeys, chosen.id)) &&
		!(await jevSaysMixedAmong(c.env.DB, filed));
	const rule: GroupRuleOfferValue | undefined = asks
		? {
				savedIds: filed,
				merchant: name || currentGroup.name,
				categoryId: chosen.id,
				category: chosen.name,
			}
		: undefined;
	// The question has an address of its own (#353), so a reload asks it again.
	const asked = rule
		? questionAddress(url.searchParams.getAll("skip"), chosen.id, filed)
		: null;
	if (!c.req.header("HX-Request")) return c.redirect(asked ?? next, 303);
	c.header(
		"HX-Trigger",
		hxTrigger({ toast: { message, type: "success" }, announce: message }),
	);
	if (asked) c.header("HX-Push-Url", asked);
	return renderOrganize(c, undefined, 200, true, rule);
});

/**
 * The items a question posts back as a JSON array, keeping only the ones `keep` accepts. Anything else posts none:
 * JSON.parse throws on what is not JSON, and a file upload reads as "[object File]".
 */
function postedItems<T>(
	value: unknown,
	keep: (item: unknown) => item is T,
): T[] {
	try {
		const items: unknown = JSON.parse(String(value ?? "[]"));
		return Array.isArray(items) ? items.filter(keep) : [];
	} catch {
		return [];
	}
}

/**
 * Not now or Yes on Organize's question (#353). Yes makes the rule on each merchant key of the charges the save
 * filed (read from the database, never from the request), and names the store in the toast; either answer moves on
 * to the next store, with focus on its name.
 */
organize.post("/transactions/organize/rule", async (c) => {
	const form = await c.req.formData();
	const url = new URL(c.req.url);
	// The skips only: an answer to the question must not carry its category or saved ids back into the question.
	const skips = new URLSearchParams(
		url.searchParams.getAll("skip").map((name) => ["skip", name]),
	);
	const next = `/transactions/organize${skips.size ? `?${skips}` : ""}`;
	const savedIds = postedItems(
		form.get("saved"),
		(id): id is number =>
			typeof id === "number" && Number.isInteger(id) && id > 0,
	);
	const categoryId = Number(form.get("category"));
	const category =
		Number.isInteger(categoryId) && categoryId > 0
			? await c.env.DB.prepare(
					"SELECT id, name FROM categories WHERE id = ? AND archived = 0",
				)
					.bind(categoryId)
					.first<{ id: number; name: string }>()
			: null;
	const ruled =
		form.get("answer") === "yes" && category && savedIds.length > 0
			? category
			: null;
	const merchant = form.get("merchant")?.toString().trim() ?? "";
	const written = ruled
		? await setOrganizeRule(
				c.env.DB,
				ruled.id,
				JSON.stringify(savedIds),
				merchant,
				actor(c),
			)
		: [];
	if (!c.req.header("HX-Request")) return c.redirect(next, 303);
	// Named only when a rule was written: a group whose charges were filed elsewhere meanwhile makes none.
	const trigger: Trigger = {};
	if (ruled && written.length > 0) {
		const message = `${merchant || written[0]} is always ${ruled.name} now.`;
		trigger.toast = { message, type: "success" };
		trigger.announce = message;
	}
	// The Save before it pushed the question's address, so the answer replaces it with the skips-only address, giving
	// one history entry, not two.
	c.header("HX-Replace-Url", next);
	return renderOrganize(c, undefined, 200, true, undefined, trigger);
});

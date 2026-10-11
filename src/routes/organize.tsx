import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { categoryNames, makeCategory, unmakeCategory } from "../db/categories";
import { formatCents } from "../money";
import { nameForm, parseCategory } from "../settings/category-form";
import { organizeGroups, saveOrganizeGroup } from "../transactions/organize";
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

export const organize = new Hono<App>();

async function renderOrganize(
	c: Context<App>,
	values?: Values,
	status: 200 | 422 = 200,
	focus = false,
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
	const query = new URLSearchParams();
	for (const name of skipped) query.append("skip", name);
	const action = `/transactions/organize${query.size ? `?${query}` : ""}`;
	const skipParams = new URLSearchParams(query);
	if (group) skipParams.append("skip", group.name);
	const skipHref = `/transactions/organize?${skipParams}`;
	const sources = group
		? `${group.bankTexts.slice(0, 3).join(", ")}${group.bankTexts.length > 3 ? ` and ${group.bankTexts.length - 3} more` : ""}`
		: "";

	return c.html(
		<Layout
			title="Organize · Tally"
			active="transactions"
			demo={c.env.DEMO === "true"}
		>
			<div id="organize-page" class="lg:max-w-3xl">
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					Organize
				</h1>
				{group ? (
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
							<p class="text-sm text-muted">
								Future {values?.name || group.name} transactions get this
								category too.
							</p>
						</form>
					</>
				) : allGroups.length > 0 ? (
					<EmptyState
						kind="done"
						sentence="You skipped the rest."
						action={{ href: "/transactions/organize", label: "Start over" }}
					/>
				) : (
					<EmptyState
						kind="done"
						sentence="Every transaction has a category."
					/>
				)}
			</div>
		</Layout>,
		status,
	);
}

organize.get("/transactions/organize", (c) => renderOrganize(c));

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
			JSON.stringify({ toast: { message, type: "info" }, announce: message }),
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
	const count = await saveOrganizeGroup(
		c.env.DB,
		currentGroup.merchantKeys,
		chosen.id,
		name && name !== currentGroup.name ? name : null,
		actor(c),
	);
	if (count === 0) {
		// Another request categorized this group after it was read, so nothing was filed: a category made
		// here goes too, and the answer is the one for a merchant that already has a category.
		if (madeId !== null) await unmakeCategory(c.env.DB, madeId);
		return alreadyCategorized();
	}
	const message = `${count} ${count === 1 ? "transaction" : "transactions"} set to ${chosen.name}.`;
	if (!c.req.header("HX-Request")) return c.redirect(next, 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce: message }),
	);
	return renderOrganize(c, undefined, 200, true);
});

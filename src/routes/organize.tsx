import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { formatCents } from "../money";
import { organizeGroups, saveOrganizeGroup } from "../transactions/organize";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import { TextInput } from "../views/text-input";

type App = { Bindings: Env };
type Category = { id: number; name: string; icon: string; color: string };
type Values = { categoryId: number | null; name?: string; error?: string };

export const organize = new Hono<App>();

async function renderOrganize(
	c: Context<App>,
	values?: Values,
	status: 200 | 422 = 200,
) {
	const params = new URL(c.req.url).searchParams;
	const skipped = params.getAll("skip");
	const [allGroups, categories] = await Promise.all([
		organizeGroups(c.env.DB),
		c.env.DB.prepare(
			"SELECT id, name, icon, color FROM categories WHERE archived = 0 ORDER BY sort_order, name",
		).all<Category>(),
	]);
	const groups = allGroups.filter((group) => !skipped.includes(group.name));
	const group = groups[0];
	const remaining = groups.reduce((sum, item) => sum + item.count, 0);
	const skipParams = new URLSearchParams();
	for (const name of skipped) skipParams.append("skip", name);
	if (group) skipParams.append("skip", group.name);
	const skipHref = `/transactions/organize?${skipParams.toString()}`;

	return c.html(
		<Layout
			title="Organize · Tally"
			active="transactions"
			demo={c.env.DEMO === "true"}
		>
			<div class="lg:max-w-3xl">
				<h1 class="font-serif text-4xl font-semibold tracking-tight">
					Organize
				</h1>
				{group ? (
					<>
						<p class="mt-2 text-muted">
							{skipped.length + 1} of {allGroups.length} · {remaining}{" "}
							transactions left
						</p>
						<div class="mt-6">
							<h2 class="text-2xl">{group.name}</h2>
							<p class="text-muted">
								{group.count}{" "}
								{group.count === 1 ? "transaction" : "transactions"} ·{" "}
								{formatCents(group.totalCents)}
							</p>
							<p class="mt-1 text-sm text-muted">
								From {group.rawNames.join(", ")}
							</p>
						</div>
						<form
							method="post"
							action="/transactions/organize"
							class="mt-5 flex flex-col gap-4"
						>
							{group.rawNames.map((rawName) => (
								<input type="hidden" name="raw_name" value={rawName} />
							))}
							<fieldset
								class="flex flex-col gap-2"
								aria-describedby={values?.error ? "category-error" : undefined}
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
								</div>
								{values?.error && (
									<p id="category-error" role="alert" class="text-sm text-over">
										{values.error}
									</p>
								)}
							</fieldset>
							<TextInput
								id="organize-name"
								name="name"
								label="Name (optional)"
								value={values?.name ?? group.name}
								autocomplete="off"
							/>
							<div class="flex items-center gap-3">
								<Button type="submit">Save and next</Button>
								<Button kind="text" href={skipHref}>
									Skip
								</Button>
							</div>
							<p class="text-sm text-muted">
								Future {values?.name ?? group.name} transactions get this
								category too.
							</p>
						</form>
					</>
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
	const rawNames = form.getAll("raw_name").map(String).filter(Boolean);
	const category =
		Number.isInteger(categoryId) && categoryId > 0
			? await c.env.DB.prepare(
					"SELECT id, name FROM categories WHERE id = ? AND archived = 0",
				)
					.bind(categoryId)
					.first<{ id: number; name: string }>()
			: null;
	if (!category)
		return renderOrganize(
			c,
			{
				categoryId: categoryId || null,
				name,
				error: "Pick a category from the list.",
			},
			422,
		);
	const count = await saveOrganizeGroup(
		c.env.DB,
		rawNames,
		category.id,
		name || null,
		actor(c),
	);
	const message = `${count} ${count === 1 ? "transaction" : "transactions"} set to ${category.name}.`;
	c.header(
		"HX-Trigger",
		JSON.stringify({ toast: { message, type: "success" }, announce: message }),
	);
	return c.redirect("/transactions/organize", 303);
});

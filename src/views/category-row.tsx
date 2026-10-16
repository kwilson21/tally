import type { SettingsCategory } from "../db/categories";
import { formatCents } from "../money";
import type { CategoryErrors } from "../settings/category-form";
import { Button } from "./button";
import { CategoryIcon } from "./category";
import { Icon } from "./icons";
import { type SavedMark, SavedSlot, savedRowClass } from "./saved-tick";
import { TextInput } from "./text-input";

/** "$600" or "$612.50": a budget as the list shows it. */
const amount = (cents: number) =>
	formatCents(cents, { wholeDollars: cents % 100 === 0 });

/** Every form on the Categories page swaps its section in place; without JavaScript it posts normally. */
export const swap = (url: string, indicator: string) => ({
	method: "post" as const,
	action: url,
	"hx-post": url,
	"hx-disable": "findAll button[type=submit]",
	"hx-indicator": `#${indicator}`,
	"hx-target": "#categories",
	"hx-select": "#categories",
	"hx-swap": "outerHTML",
});

/**
 * A second submit button in a form that posts somewhere else (Archive, Move): `formaction` without
 * JavaScript, and its own htmx request with it. htmx 4 doesn't inherit hx-target, so it's repeated.
 */
const action = (url: string, formId: string) => ({
	formaction: url,
	"hx-post": url,
	"hx-disable": `#${formId} button[type=submit]`,
	"hx-target": "#categories",
	"hx-select": "#categories",
	"hx-swap": "outerHTML",
});

export const summaryClass =
	"flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 [&::-webkit-details-marker]:hidden";
export const chevron = (
	<span class="shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none">
		<Icon name="chevron-right" class="size-5" />
	</span>
);

/** The name field, for adding a category or renaming one. Budgets are set on Home (decision 38). */
function NameField({
	idPrefix,
	name,
	errors = {},
}: {
	idPrefix: string;
	name: string;
	errors?: CategoryErrors;
}) {
	return (
		<TextInput
			id={`${idPrefix}-name`}
			label="Name"
			name="name"
			value={name}
			maxlength={40}
			autocomplete="off"
			autofocus={Boolean(errors.name)}
			error={errors.name}
			class="sm:max-w-sm"
		/>
	);
}

/**
 * One category's disclosure row in Settings' list (decision 72's shape): closed, its icon, name, this
 * month's budget and a chevron; open, its Name field, Save, Cancel, Archive and the moves. The route
 * passes what the row reads from the page; the open row alone shows what was typed and its errors.
 */
export function CategoryRow({
	category: c,
	first,
	last,
	open,
	focus,
	values,
	errors,
	saved,
}: {
	category: SettingsCategory;
	first: boolean;
	last: boolean;
	/** The row is open: its form shows, with what was typed and any errors. */
	open: boolean;
	/** Move focus to this row's summary after a swap. */
	focus: boolean;
	values?: { name: string };
	errors?: CategoryErrors;
	/** The row whose save just answered: its chevron gives way to the pencil tick (P119 A, #71). */
	saved?: SavedMark;
}) {
	const url = `/settings/categories/${c.id}`;
	const formId = `cat-${c.id}-form`;
	return (
		<details
			class={`group border-b border-rule${saved ? ` ${savedRowClass(saved)}` : ""}`}
			data-row={c.id}
			open={open}
		>
			<summary data-category={c.id} class={summaryClass} autofocus={focus}>
				<CategoryIcon icon={c.icon} color={c.color} />
				<span class="min-w-0 truncate text-lg font-medium">{c.name}</span>
				<span id={`cat-${c.id}-amount`} class="ml-auto shrink-0 tabular-nums">
					{c.budgetCents === null ? (
						<span class="text-muted">No budget</span>
					) : (
						<>
							{amount(c.budgetCents)}
							<span class="text-muted"> a month</span>
						</>
					)}
				</span>
				{saved ? (
					<SavedSlot class="shrink-0 text-muted">{chevron}</SavedSlot>
				) : (
					chevron
				)}
			</summary>
			<div class="flex flex-col gap-4 pb-5 sm:pl-11">
				<form
					id={formId}
					class="flex flex-col gap-4"
					{...swap(url, `cat-${c.id}-save`)}
				>
					<NameField
						idPrefix={`c${c.id}`}
						name={open && values ? values.name : c.name}
						errors={open ? errors : undefined}
					/>
					<p id={`cat-${c.id}-budget-note`} class="text-muted">
						{c.budgetCents === null ? "No budget yet. " : ""}
						<a
							href={`/budget/${c.id}`}
							id={`cat-${c.id}-budget-link`}
							class="inline-flex min-h-11 items-center"
						>
							{c.budgetCents === null
								? "Add one on Home"
								: "Change its budget on Home"}
						</a>
					</p>
					<div class="flex flex-wrap items-center gap-3">
						<Button id={`cat-${c.id}-save`} type="submit" busyLabel="Saving…">
							Save
						</Button>
						<Button
							href="/settings/categories"
							kind="secondary"
							// Back to the list with focus on this row, so the change is announced.
							hx-get={`/settings/categories?focus=${c.id}`}
							hx-target="#categories"
							hx-select="#categories"
							hx-swap="outerHTML"
						>
							Cancel
						</Button>
						<Button
							type="submit"
							kind="text"
							class="ml-auto"
							busyLabel="Archiving…"
							id={`cat-${c.id}-archive`}
							{...action(`${url}/archive`, formId)}
						>
							Archive
						</Button>
					</div>
					{!(first && last) && (
						<div class="flex flex-wrap gap-2">
							{!first && (
								<Button
									type="submit"
									kind="secondary"
									class="gap-2"
									busyLabel="Moving…"
									id={`cat-${c.id}-move-up`}
									{...action(`${url}/move/up`, formId)}
								>
									<Icon name="arrow-up" class="size-4" />
									Move up
								</Button>
							)}
							{!last && (
								<Button
									type="submit"
									kind="secondary"
									class="gap-2"
									busyLabel="Moving…"
									id={`cat-${c.id}-move-down`}
									{...action(`${url}/move/down`, formId)}
								>
									<Icon name="arrow-down" class="size-4" />
									Move down
								</Button>
							)}
						</div>
					)}
				</form>
			</div>
		</details>
	);
}

/**
 * Settings' Add category row, the last row of the list: a plus and the words in accent. Open, it
 * holds the Name field and Add category; what was typed and its error show only while it's open.
 */
export function AddCategoryRow({
	open,
	values,
	errors,
}: {
	open: boolean;
	values?: { name: string };
	errors?: CategoryErrors;
}) {
	return (
		<details class="group border-b border-rule" data-row="new" open={open}>
			<summary class={`${summaryClass} text-accent`}>
				<Icon name="plus" class="size-5" />
				Add category
			</summary>
			<form
				id="new-category-form"
				class="flex flex-col gap-4 pb-5"
				{...swap("/settings/categories", "new-category-save")}
			>
				<NameField
					idPrefix="new"
					name={open && values ? values.name : ""}
					errors={open ? errors : undefined}
				/>
				<div>
					<Button id="new-category-save" type="submit" busyLabel="Adding…">
						Add category
					</Button>
				</div>
			</form>
		</details>
	);
}

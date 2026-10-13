import type { Child } from "hono/jsx";
import { shortDay } from "../dates";
import type { SuggestionItem } from "../db/suggestions-queue";
import { formatCents } from "../money";
import { Button } from "./button";
import { Chip } from "./chip";
import { Icon } from "./icons";
import { NameChoices } from "./name-choices";
import { WhyLink } from "./why-link";

/** The dashed "Maybe …" tag at question size: the one question on a screen (spec §8.6, P42 A). */
export function MaybeQuestion({ children }: { children: Child }) {
	return (
		<p class="inline-flex min-h-11 max-w-full items-center gap-2 self-start rounded-control border border-dashed border-ink px-3 font-serif text-3xl font-semibold text-ink">
			<Icon name="circle-dashed" class="size-6 shrink-0" />
			<span class="min-w-0 wrap-anywhere">{children}</span>
		</p>
	);
}

/** "Chewy, Petsmart and Banfield", as the question and the line read it. */
export function joinStores(labels: string[]): string {
	if (labels.length <= 1) return labels[0] ?? "";
	return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** Tally's guess and how sure it is, with a Why? to the page that explains it (spec §8.6, P87 B). */
function Guess({
	sure,
	section,
}: {
	/** How sure Tally is, as a whole percent; a name Tally guessed has no percent. */
	sure?: number;
	section: "categorization" | "exclusions" | "names";
}) {
	return (
		<p class="flex flex-wrap items-center gap-x-2 text-sm text-ink">
			<span class="inline-flex items-center gap-1.5">
				<Icon name="sparkles" class="size-4" />
				Tally's guess{sure === undefined ? "" : ` · ${sure}% sure`}
			</span>
			<WhyLink section={section} topic="Tally's guess" />
		</p>
	);
}

/** The hidden fields that name a rule's stores: sent back by the question's Yes (decision 101). */
function StoreFields({ stores }: { stores: { merchantKey: string }[] }) {
	return (
		<>
			{stores.map((store) => (
				<input type="hidden" name="store" value={store.merchantKey} />
			))}
		</>
	);
}

/**
 * The attributes every answer form shares: it posts to the screen's address and swaps the whole page.
 * hx-disable turns every answer button on the screen off while a request runs, so a double click can't
 * queue a second answer (#460). hx-sync puts every answer form on the screen in one request queue, and that
 * queue drops an answer sent while another is running, so a second press can't queue one either.
 */
const answerForm = (action: string) => ({
	method: "post" as const,
	action,
	"hx-post": action,
	"hx-disable": "#suggestions-page button[type=submit]",
	"hx-sync": "#suggestions-page:drop",
	"hx-target": "#suggestions-page",
	"hx-select": "#suggestions-page",
	"hx-swap": "outerHTML",
});

/**
 * The question after a No on income, a transfer or a new category: one yes-or-no, with Not now and Yes.
 * Only Yes makes the "Never suggest" line (decision 101); Not now moves on with no rule.
 */
export function AskFirst({
	action,
	kind,
	id,
	name,
	stores,
	check,
	focus = false,
}: {
	/** The screen's address, with its skips: the answer posts there. */
	action: string;
	kind: "income" | "transfer" | "new_category";
	id: string;
	/** The suggested new category's name ("Pet Care"). */
	name?: string;
	/** The stores the line would cover, each sent back as a hidden `store` value. */
	stores: { merchantKey: string; label: string }[];
	/** The muted check: what the No has already decided. */
	check?: string;
	focus?: boolean;
}) {
	const labels = joinStores(stores.map((store) => store.label));
	const subject =
		kind === "income"
			? "income"
			: kind === "transfer"
				? "a transfer"
				: (name ?? "a new category");
	return (
		<div class="flex flex-col gap-3">
			{check && (
				<p class="flex items-center gap-2 text-muted">
					<Icon name="check" class="size-5" />
					{check}
				</p>
			)}
			<h2
				id="suggestion-title"
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="font-serif text-4xl font-semibold tracking-tight outline-none"
			>
				Don't suggest {subject} again for {labels}?
			</h2>
			<p>Say yes and Tally stops asking this for {labels}.</p>
			<form {...answerForm(action)} class="grid grid-cols-2 gap-3">
				<input type="hidden" name="id" value={id} />
				<input type="hidden" name="kind" value={kind} />
				<StoreFields stores={stores} />
				<Button
					kind="secondary"
					type="submit"
					name="answer"
					value="ask_not_now"
					class="w-full"
				>
					Not now
				</Button>
				<Button type="submit" name="answer" value="ask_yes" class="w-full">
					Yes
				</Button>
			</form>
		</div>
	);
}

/**
 * The one item on the review screen (spec §8.6, P42 A, P76 A, P87 B, P88 A): the store's name, its bank
 * text, the amount and day, the one question, and its answers. Yes is the full-width primary; Something
 * else opens in place with no script and answers only this item; No (on income, a transfer or a new
 * category) asks first; Skip is quiet.
 */
export function SuggestionCard({
	action,
	item,
	today,
	skipHref,
	categories,
	values,
	error,
	focus = false,
}: {
	/** The screen's address, with its skips: every answer posts there. */
	action: string;
	item: SuggestionItem;
	today: string;
	/** The address that skips this item. */
	skipHref: string;
	/** Active categories, for Something else on a category guess. */
	categories: { id: number; name: string }[];
	/** What the form held when it was posted (the Name row, or the ticks), shown again with its error. */
	values?: { picked?: string | null; own?: string; ticked?: number[] };
	error?: string;
	focus?: boolean;
}) {
	return (
		<div class="flex flex-col gap-5">
			{item.kind === "name" ? (
				<NameHeading item={item} focus={focus} />
			) : item.kind === "new_category" ? (
				<NewCategoryHeading item={item} today={today} focus={focus} />
			) : (
				<TransactionHeading item={item} today={today} focus={focus} />
			)}
			{/* A name's error sits under its Name row, where its choice is (NameChoices), so it is not repeated here. */}
			{error && item.kind !== "name" && (
				<p role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
			{item.kind === "income" && (
				<>
					<MaybeQuestion>Maybe a paycheck</MaybeQuestion>
					<h3 class="font-serif text-2xl font-semibold">
						Count it as income, not spending?
					</h3>
					<Guess sure={item.sure} section="categorization" />
					<YesNoForm action={action} item={item} yes="Yes, it's income" />
				</>
			)}
			{item.kind === "transfer" && (
				<>
					<MaybeQuestion>Maybe a transfer</MaybeQuestion>
					<h3 class="font-serif text-2xl font-semibold">
						Leave it out of the budget?
					</h3>
					<Guess sure={item.sure} section="exclusions" />
					<YesNoForm
						action={action}
						item={item}
						yes="Yes, leave it out"
						no="No, it's spending"
					/>
				</>
			)}
			{item.kind === "category" && (
				<>
					<MaybeQuestion>Maybe {item.category}</MaybeQuestion>
					<Guess sure={item.sure} section="categorization" />
					<YesForm action={action} item={item} yes={`Yes, ${item.category}`} />
					<SomethingElse
						action={action}
						item={item}
						categories={categories}
						error={error}
					/>
				</>
			)}
			{item.kind === "new_category" && (
				<>
					<MaybeQuestion>Maybe new: {item.name}</MaybeQuestion>
					<Guess section="categorization" />
					<NewCategoryForm
						action={action}
						item={item}
						today={today}
						ticked={values?.ticked}
					/>
				</>
			)}
			{item.kind === "name" && (
				<>
					{item.review.source === "bank" ? (
						<p class="text-sm text-muted">From your bank</p>
					) : (
						<Guess section="names" />
					)}
					<YesForm
						action={action}
						item={item}
						yes={`Yes, ${item.review.names[0] ?? ""}`}
					/>
					<SomethingElse
						action={action}
						item={item}
						categories={categories}
						values={values}
						error={error}
					/>
				</>
			)}
			<p class="text-center">
				<a
					href={skipHref}
					class="inline-flex min-h-11 items-center text-accent"
				>
					Skip
				</a>
			</p>
		</div>
	);
}

function TransactionHeading({
	item,
	today,
	focus,
}: {
	item: Extract<SuggestionItem, { kind: "income" | "transfer" | "category" }>;
	today: string;
	focus: boolean;
}) {
	return (
		<div>
			<h2
				id="suggestion-title"
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="font-serif text-3xl font-semibold tracking-tight outline-none"
			>
				{item.label}
			</h2>
			<p class="mt-1 text-sm text-muted wrap-anywhere">{item.bankText}</p>
			<p class="text-muted">
				{formatCents(Math.abs(item.amountCents))} · {shortDay(item.date, today)}
			</p>
		</div>
	);
}

function NewCategoryHeading({
	item,
	today,
	focus,
}: {
	item: Extract<SuggestionItem, { kind: "new_category" }>;
	today: string;
	focus: boolean;
}) {
	const count = item.rows.length;
	return (
		<div>
			<h2
				id="suggestion-title"
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="font-serif text-3xl font-semibold tracking-tight wrap-anywhere outline-none"
			>
				{joinStores(item.stores.map((store) => store.merchant))}
			</h2>
			<p class="text-muted">
				{count} {count === 1 ? "transaction" : "transactions"} ·{" "}
				{shortDay(item.date, today)}
			</p>
		</div>
	);
}

function NameHeading({
	item,
	focus,
}: {
	item: Extract<SuggestionItem, { kind: "name" }>;
	focus: boolean;
}) {
	const { count, bankText } = item.review;
	return (
		<div>
			<p class="text-sm text-muted">The bank says</p>
			<h2
				id="suggestion-title"
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="font-serif text-3xl font-semibold tracking-tight wrap-anywhere outline-none"
			>
				{bankText}
			</h2>
			<p class="text-muted">
				{count} {count === 1 ? "transaction" : "transactions"} ·{" "}
				{formatCents(Math.abs(item.totalCents))}
			</p>
		</div>
	);
}

/** Yes and No in one form, Yes first so Enter keeps the primary answer. */
function YesNoForm({
	action,
	item,
	yes,
	no = "No",
}: {
	action: string;
	item: SuggestionItem;
	yes: string;
	no?: string;
}) {
	return (
		<form {...answerForm(action)} class="flex flex-col gap-3">
			<input type="hidden" name="id" value={item.id} />
			<Button type="submit" name="answer" value="yes" class="w-full">
				{yes}
			</Button>
			<Button
				kind="secondary"
				type="submit"
				name="answer"
				value="no"
				class="w-full"
			>
				{no}
			</Button>
		</form>
	);
}

/** The full-width primary Yes, on its own. */
function YesForm({
	action,
	item,
	yes,
}: {
	action: string;
	item: SuggestionItem;
	yes: string;
}) {
	return (
		<form {...answerForm(action)}>
			<input type="hidden" name="id" value={item.id} />
			<Button type="submit" name="answer" value="yes" class="w-full">
				{yes}
			</Button>
		</form>
	);
}

/**
 * Something else: a disclosure that opens in place with no script. It answers this one item only and
 * never makes a rule (decision 101).
 */
function SomethingElse({
	action,
	item,
	categories,
	values,
	error,
}: {
	action: string;
	item: SuggestionItem;
	categories: { id: number; name: string }[];
	/** What the Name row held when it was posted, shown again with its error. */
	values?: { picked?: string | null; own?: string };
	/** The refusal to show: open with it, so its chips or names are on screen. */
	error?: string;
}) {
	return (
		<details
			class="group rounded-control border border-rule px-4"
			open={Boolean(error)}
		>
			<summary class="flex min-h-11 cursor-pointer items-center justify-between text-lg">
				Something else
				<Icon
					name="chevron-right"
					class="size-5 transition group-open:rotate-90"
				/>
			</summary>
			<form {...answerForm(action)} class="flex flex-col gap-4 pb-4 pt-2">
				<input type="hidden" name="id" value={item.id} />
				{item.kind === "category" && (
					<fieldset class="flex flex-col gap-2">
						<legend class="text-base text-ink">Category</legend>
						<div class="flex flex-wrap gap-2">
							{categories.map((category) => (
								<Chip type="radio" name="category" value={String(category.id)}>
									{category.name}
								</Chip>
							))}
						</div>
					</fieldset>
				)}
				{item.kind === "name" && (
					<NameChoices
						id={`suggestion-${item.review.id}`}
						names={item.review.names}
						source={item.review.source}
						tidied={item.review.tidied}
						picked={values?.picked}
						own={values?.own}
						error={error}
						focusFirst={Boolean(error)}
					/>
				)}
				<Button type="submit" name="answer" value="else" class="w-full">
					Save and next
				</Button>
			</form>
		</details>
	);
}

/**
 * A new category: each purchase ticked to go in, and Yes or No. One form holds the ticks, so Yes sends
 * them; Tally names the purchases it shows (`shown`) so the server can check each tick.
 */
function NewCategoryForm({
	action,
	item,
	today,
	ticked,
}: {
	action: string;
	item: Extract<SuggestionItem, { kind: "new_category" }>;
	today: string;
	/** The ticks a refused answer posted; left out, every purchase starts ticked. */
	ticked?: number[];
}) {
	return (
		<form {...answerForm(action)} class="flex flex-col gap-4">
			<input type="hidden" name="id" value={item.id} />
			<p class="text-sm text-muted">Untick any that don't belong.</p>
			<ul class="flex flex-wrap gap-2">
				{item.rows.map((row) => (
					<li>
						<input
							type="hidden"
							name="shown"
							value={String(row.transactionId)}
						/>
						<Chip
							type="checkbox"
							name="ticked"
							value={String(row.transactionId)}
							checked={ticked ? ticked.includes(row.transactionId) : true}
						>
							{row.label} · {formatCents(Math.abs(row.amountCents))} ·{" "}
							{shortDay(row.date, today)}
						</Chip>
					</li>
				))}
			</ul>
			<div class="flex flex-col gap-3">
				<Button type="submit" name="answer" value="yes" class="w-full">
					{item.existing
						? `Yes, add to ${item.existing}`
						: `Yes, create ${item.name}`}
				</Button>
				<Button
					kind="secondary"
					type="submit"
					name="answer"
					value="no"
					class="w-full"
				>
					No
				</Button>
			</div>
		</form>
	);
}

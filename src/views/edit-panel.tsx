import type { Child } from "hono/jsx";
import { JEV_THRESHOLD } from "../ai/categorize";
import { unpaidBillsNote } from "../bills/unpaid";
import { dayLabel, shortDay } from "../dates";
import { isIncluded } from "../db/counted-month";
import { mixedCategories } from "../db/mixed-trip";
import type { RefundPurchase, TransactionDetail } from "../db/transactions";
import { formatCents } from "../money";
import {
	type Edit,
	type EditErrors,
	excludedAfterSave,
	followsPurchaseAfterSave,
} from "../transactions/edit";
import { refundPurchaseLabel } from "../transactions/refund-guards";
import { jevAsksAbout } from "../transactions/rename";
import { BottomSheet } from "./bottom-sheet";
import { Button } from "./button";
import { CategoryIcon } from "./category";
import { CategoryGrid } from "./category-grid";
import { Chip } from "./chip";
import { DetailRow } from "./detail-row";
import { FoldedRow } from "./folded-row";
import { FormField } from "./form-field";
import type { HouseholdPerson } from "./household-people";
import { Icon } from "./icons";
import { maybeIncomeVisible, SuggestedCategoryChip } from "./maybe-category";
import { MerchantRuleTick } from "./merchant-rule-tick";
import { MixedTripLine } from "./mixed-trip-line";
import { MoneyInput } from "./money-input";
import {
	EDIT_FORM_GROUP,
	LINKED_PURCHASE_CLASS,
	NameChoices,
	SUGGESTED_NAME_CLASS,
} from "./name-choices";
import { NEW_CATEGORY_GROUP, NewCategoryName } from "./new-category-choice";
import { PendingNote } from "./pending-note";
import { Switch } from "./switch";
import { TextInput } from "./text-input";
import { WhyLink } from "./why-link";

/** A category as the edit panel and Organize's sheet draw it: its id, name, icon and color token. */
export type Category = {
	id: number;
	name: string;
	icon: string;
	color: string;
};

// A payment that pays a bill or a planned expense counts whatever its exclusion (spec §8.5, decision 82). These
// sentences are the panel's top lines and the Exclude switch's line, so their words can't drift apart.
const PAYS_BILL_COUNTS = "It pays a bill, so it counts in the budget.";
const PAYS_PLAN_COUNTS =
	"It pays a planned expense, so it counts in the budget.";

/** The Exclude switch's muted line: the sentence that says a bill or planned payment counts, else the plain one. */
function excludeHint(tx: TransactionDetail) {
	if (tx.paysBill) return PAYS_BILL_COUNTS;
	if (tx.paysPlan) return PAYS_PLAN_COUNTS;
	return "It won't count in Spent or any budget.";
}

type SheetProps = {
	tx: TransactionDetail;
	back: string;
	categories: Category[];
	people: HouseholdPerson[];
	values: Edit;
	errors?: EditErrors;
	cashValues?: { date: string; amount: string };
	/**
	 * A cash amount that broke its parts: the amount it was refused at, which "Change the parts" opens
	 * the split with (spec §8.4). Set only for that refusal.
	 */
	changePartsTotalCents?: number;
	deleteConfirm?: boolean;
	refunds?: RefundPurchase[];
	/** The household's date, for the transaction's "Today" label. */
	today: string;
	/** The Name row choice that was ticked when the form was posted, shown again after an error. */
	namePick?: string | null;
	/**
	 * What the name field held when the panel was first drawn, which a redraw after an error carries
	 * through from the posted form, unchanged. Without it the panel is first drawn: the merchant's name now.
	 */
	nameWas?: string | null;
	/** The Rename list's choice as it was posted ("all" renames the merchant); "one" when first drawn. */
	nameScope?: "one" | "all";
	/** Jev answers categories now, so a one-off name's Rename list says Tally guesses again (decision 101). */
	jevCategories?: boolean;
	/**
	 * The rule's category name as the posted panel showed it, passed only on a refused save's redraw; a first
	 * draw uses tx.merchantRuleCategoryName. For display only: the save never reads it.
	 */
	ruleCategoryName?: string;
	/**
	 * The panel is already open and is drawn again where it is, so it isn't drawn arriving: Keep it,
	 * after the delete question. A field's error and the question itself are known from the props.
	 */
	still?: boolean;
};

function showEditIncomeGuess(tx: TransactionDetail, posted: Edit) {
	return (
		posted.income === tx.income &&
		posted.creditReviewed === tx.creditReviewedByUser &&
		maybeIncomeVisible(tx)
	);
}

/**
 * The list address with `focus` set, so the list it draws puts focus on that row or control. A sheet's close
 * asks for it, as a plain link without JavaScript and as its htmx swap with it.
 */
export function withFocus(href: string, focus: string | number): string {
	return `${href}${href.includes("?") ? "&" : "?"}focus=${focus}`;
}

/**
 * Closing a sheet swaps the list back in and returns focus to this transaction's row; the pushed URL
 * stays clean.
 */
export function listCloseAttrs(
	back: string,
	id: number,
): Record<string, string> {
	return {
		"hx-get": withFocus(back, id),
		"hx-target": "#page",
		"hx-select": "#page",
		"hx-swap": "outerHTML",
		"hx-push-url": back,
	};
}

/**
 * The purchase a linked refund is linked to (`linked`), and the one its category is locked to (`locked`): the
 * refund counts with that purchase once the panel is saved (followsPurchaseAfterSave), so its category is the
 * purchase's and the panel's category choice is disabled.
 */
export function linkedPurchases(
	tx: TransactionDetail,
	values: Pick<
		Edit,
		| "refundOfId"
		| "income"
		| "incomeWas"
		| "creditReviewed"
		| "creditReviewedWas"
		| "creditReviewedProvided"
	>,
	refunds: RefundPurchase[],
) {
	const linked = refunds.find((p) => p.id === values.refundOfId && !p.excluded);
	return {
		linked,
		locked: linked && followsPurchaseAfterSave(tx, values) ? linked : undefined,
	};
}

/** The lock's sentence: where a linked refund counts, named by its purchase's category while that category exists. */
export function countsWithPurchase(
	purchase: RefundPurchase,
	categories: Category[],
	date: string,
) {
	const category = categories.find((cat) => cat.id === purchase.categoryId);
	const day = shortDay(purchase.date, date);
	return category
		? `Counts in ${category.name} with the ${day} purchase.`
		: `Counts with the ${day} purchase.`;
}

/**
 * The panel's category (spec §8, P120 B), which leads the panel. While the transaction needs one (none yet, or
 * Tally's guess waits as a chip), the choices are open: a two-column grid ending in New category (decision 101),
 * with Tally's guess as its first cell, and the source line under the legend. Once it has one, the category folds
 * to a ruled row that shows its name and its source and opens in place. It opens by itself when the post has a
 * category error or New category is chosen, so an error is never hidden. A linked refund that counts with its
 * purchase is locked: the choice is disabled and drawn open, with the purchase's category and the "Counts in" line.
 * The choice sits in its own wrapper, which the category lock route draws again when Count as income or Reviewed
 * changes (`#edit-category`). A locked choice's last pick sits in hidden fields after the disabled fieldset, since a
 * browser posts nothing from a disabled one. A trip that looks mixed (#233) draws its split line under the chips, or
 * under the folded row, so it shows with the row closed. The merchant rule tick (#353, `rule`) follows the choices in
 * both states.
 */
export function CategoryChoice({
	tx,
	categories,
	values,
	errors = {},
	purchase,
	back,
	rule,
}: {
	tx: TransactionDetail;
	categories: Category[];
	values: Pick<Edit, "categoryId" | "newCategory" | "newCategoryName">;
	errors?: EditErrors;
	purchase?: RefundPurchase;
	back: string;
	/** The merchant rule tick, for a row that can have a rule: whether it's ticked and the rule's category name. */
	rule?: { checked: boolean; ruleCategory?: string };
}) {
	// The two categories Jev named, when this trip looks mixed (#233): the line and its split name them.
	const mixed = mixedCategories(tx);
	// Tally's guess waits unsure: its line sits under the legend, and when it names a category its dashed chip is the
	// grid's first cell.
	const unsureGuess =
		!purchase &&
		tx.categorySource !== "jev" &&
		Boolean(tx.maybeCategoryName) &&
		!tx.maybeCategoryNew &&
		Boolean(tx.suggestedCategoryName) &&
		tx.categoryConfidence !== null &&
		tx.categoryConfidence < JEV_THRESHOLD;
	const guessChip = unsureGuess && tx.suggestedCategoryId !== null;
	// The saved category once it's archived: the active list doesn't hold it, so its row still folds and names it.
	// Only while the posted choice is that saved category, so a category error's null never folds a row.
	const archivedSaved =
		values.categoryId !== null &&
		values.categoryId === tx.categoryId &&
		tx.categoryName !== null &&
		tx.categoryIcon !== null &&
		tx.categoryColor !== null
			? {
					id: values.categoryId,
					name: tx.categoryName,
					icon: tx.categoryIcon,
					color: tx.categoryColor,
				}
			: undefined;
	const chosen =
		categories.find((cat) => cat.id === values.categoryId) ?? archivedSaved;
	const needsCategory = tx.categoryId === null || guessChip;
	// Folded once it has one (or New category is chosen, which the row says).
	const folded =
		!purchase && !needsCategory && (chosen !== undefined || values.newCategory);
	// Opens by itself for New category or a category error, so an error is never inside a closed row (a saved category
	// archived since the panel opened still folds the row).
	const openFolded =
		values.newCategory === true || errors.category !== undefined;
	// The line says how the saved category was settled. A redraw after a refused save with another choice posted says
	// nothing about the saved one, so the line goes unless the posted choice is the saved category or Tally's guess.
	const savedChoice =
		!values.newCategory &&
		(values.categoryId === tx.categoryId ||
			(guessChip && values.categoryId === tx.suggestedCategoryId));
	const source = savedChoice
		? categorySource(tx, unsureGuess, purchase !== undefined)
		: undefined;
	// A trip Jev says looks mixed (#233, decision 113): one quiet line, and its link opens the split with Tally's guessed parts.
	const mixedLine = !purchase && mixed && (
		<MixedTripLine
			first={mixed.first.name}
			second={mixed.second.name}
			href={`/transactions/${tx.id}/split?back=${encodeURIComponent(back)}`}
		/>
	);
	const choiceValue: Child = values.newCategory ? (
		<span class="text-accent">New category</span>
	) : (
		chosen && (
			<>
				<CategoryIcon icon={chosen.icon} color={chosen.color} />
				<span class="truncate text-lg">{chosen.name}</span>
			</>
		)
	);
	const choices = (
		<>
			<CategoryGrid
				categories={categories}
				checkedId={purchase ? purchase.categoryId : values.categoryId}
				tallyId={tx.categoryId}
				leading={
					guessChip &&
					tx.suggestedCategoryId !== null &&
					tx.suggestedCategoryName ? (
						<SuggestedCategoryChip
							name={tx.suggestedCategoryName}
							value={String(tx.suggestedCategoryId)}
							sure={Math.round((tx.categoryConfidence ?? 0) * 100)}
							transactionId={tx.id}
						/>
					) : undefined
				}
				newCategory
				newChecked={!purchase && values.newCategory === true}
			/>
			{/* Under the chips while they're open. Once folded it's drawn under the row instead (below), outside the row's details. */}
			{!folded && mixedLine}
			{/* Opens under the chips while New category is chosen (CSS, decision 101). */}
			<NewCategoryName
				id="new-category-name"
				value={values.newCategoryName ?? ""}
				hint="Added to your categories and used for this transaction."
				error={errors.newCategory}
			/>
			{purchase && (
				<p class="text-sm text-muted">
					{countsWithPurchase(purchase, categories, tx.date)}
				</p>
			)}
			{errors.category && (
				<p id="category-error" role="alert" class="text-sm text-over">
					{errors.category}
				</p>
			)}
		</>
	);
	const ruleTick = rule && (
		<div class="pt-3">
			<MerchantRuleTick
				merchant={tx.storeName}
				checked={rule.checked}
				ruleCategory={rule.ruleCategory}
			/>
		</div>
	);
	return (
		<div id="edit-category">
			{folded ? (
				<>
					<FoldedRow
						label="Category"
						open={openFolded}
						sub={source}
						value={choiceValue}
					>
						<fieldset
							class={`flex flex-col gap-2 ${NEW_CATEGORY_GROUP}`}
							aria-describedby={errors.category ? "category-error" : undefined}
						>
							<legend class="sr-only">Category</legend>
							{choices}
						</fieldset>
						{ruleTick}
					</FoldedRow>
					{mixedLine}
				</>
			) : (
				<>
					<fieldset
						class={`flex flex-col gap-2 ${NEW_CATEGORY_GROUP}`}
						disabled={purchase !== undefined}
						aria-describedby={errors.category ? "category-error" : undefined}
					>
						<legend class="text-base text-ink">Category</legend>
						{source && <p class="text-sm text-muted">{source}</p>}
						{choices}
					</fieldset>
					{ruleTick}
				</>
			)}
			{/* Only while locked: an open choice's radios post category themselves, and a copy would post it twice. */}
			{purchase && (values.newCategory || values.categoryId !== null) && (
				<input
					type="hidden"
					name="category"
					value={values.newCategory ? "new" : String(values.categoryId)}
				/>
			)}
			{purchase && values.newCategoryName && (
				<input
					type="hidden"
					name="new_category_name"
					value={values.newCategoryName}
				/>
			)}
		</div>
	);
}

/**
 * The line under the category: a bank bill's category keeps its Why? link; Tally's pick and its sureness, or Tally's
 * guess. A person's choice or a merchant rule has no line. A locked choice shows its "Counts in" line instead (`locked`).
 */
function categorySource(
	tx: TransactionDetail,
	guessLine: boolean,
	locked: boolean,
): Child | undefined {
	if (tx.categorySource === "bill")
		return <WhyLink section="categorization" topic="this category" />;
	if (locked) return undefined;
	if (tx.categorySource === "jev" && tx.categoryConfidence !== null)
		return `Picked by Tally · ${Math.round(tx.categoryConfidence * 100)}% sure`;
	if (guessLine && tx.categoryConfidence !== null)
		return `Tally's guess · ${Math.round(tx.categoryConfidence * 100)}% sure`;
	return undefined;
}

/** The edit panel for one transaction (spec §8): category, merchant rule, name, note. */
export function EditSheet({
	tx,
	back,
	categories,
	people,
	values,
	errors = {},
	cashValues,
	changePartsTotalCents,
	deleteConfirm = false,
	refunds = [],
	today,
	namePick = null,
	nameWas = null,
	nameScope = "one",
	jevCategories = false,
	ruleCategoryName,
	still = false,
}: SheetProps) {
	const editHref = `/transactions/${tx.id}${back.includes("?") ? back.slice(back.indexOf("?")) : ""}`;
	// Where Cancel and the backdrop go without JavaScript: the list, with focus on this row.
	const closeHref = withFocus(back, tx.id);
	const closeAttrs = listCloseAttrs(back, tx.id);
	const account = `${tx.accountName}${tx.accountMask ? ` ••${tx.accountMask}` : ""}`;
	// A refund that follows its purchase counts in that purchase's category, so its own can't be picked
	// while it does. Whether it follows is the counting rule on what a save would hold, so the lock and the
	// "Counts in" line say how the row really counts.
	const { linked: linkedPurchase, locked: purchase } = linkedPurchases(
		tx,
		values,
		refunds,
	);
	// Count as income and Reviewed lock a linked credit's category, so a change draws that choice again (/category/lock).
	const lockRedraw = linkedPurchase
		? {
				"hx-post": `/transactions/${tx.id}/category/lock`,
				"hx-trigger": "change",
				"hx-target": "#edit-category",
				"hx-select": "#edit-category > *",
				// Morphs, so a folded row keeps the open state the person set (#661; layout.tsx's morphIgnore).
				"hx-swap": "innerMorph",
				"hx-sync": "#edit-category:queue last",
				"hx-include": "closest form",
			}
		: {};
	// The For name drawn for the posted choice: none while nothing is chosen (the placeholder asks for the people) or the
	// person is gone, so their row has no source line either.
	const forName =
		values.forPersonId == null
			? null
			: (people.find((person) => person.id === values.forPersonId)?.name ??
				null);
	// A detail draws as Tally's guess only while it holds the value Tally filled in. A refused save draws what the person
	// posted, and the posted `*_was` field holds the value as it was first drawn, so a changed or emptied value is the
	// person's: no dashes, and no source line when it is empty.
	const noteGuessed =
		Boolean(values.note) &&
		tx.noteGuessed &&
		values.note === (values.noteWas ?? values.note);
	const kindGuessed =
		Boolean(values.kind) &&
		tx.kindGuessed &&
		values.kind === (values.kindWas ?? values.kind);
	const forPersonGuessed =
		forName !== null &&
		tx.forPersonGuessed &&
		values.forPersonId === (values.forPersonIdWas ?? values.forPersonId);
	const showIncomeGuess = showEditIncomeGuess(tx, values);
	// Whether the row counts with the review ticked or unticked, read as if Exclude were ticked, income off and no new link
	// (excludedAfterSave). So it asks only whether the review lifts the exclusion that Exclude stands for, which the
	// panel's hooks need even after a redraw that posted Exclude off or Income on.
	const countsIfReviewed = (creditReviewed: boolean) =>
		isIncluded(
			excludedAfterSave(tx, {
				...values,
				excluded: true,
				income: false,
				refundOfId: tx.refundOfId ?? null,
				creditReviewed,
			}),
			tx.paysBill === true || tx.paysPlan === true,
		);
	return (
		<BottomSheet
			labelledBy="edit-title"
			closeHref={closeHref}
			closeAttrs={closeAttrs}
			// A field's error and the delete question draw the open panel again.
			still={still || deleteConfirm || Object.keys(errors).length > 0}
		>
			<h2
				id="edit-title"
				tabindex={-1}
				// Focused only so screen readers start here; it isn't a control, so no ring. While the sheet
				// asks about a delete, the question takes the focus instead (one autofocus, or htmx picks the first).
				autofocus={!deleteConfirm}
				// Kept: a name a person typed can be one long unbroken token, so it alone may break inside a word (E, DESIGN.md).
				class={`min-w-0 max-w-full wrap-anywhere font-serif text-3xl font-semibold tracking-tight outline-none ${tx.nameSuggested ? SUGGESTED_NAME_CLASS : ""}`}
			>
				{tx.displayName}
				{tx.nameSuggested && <span class="sr-only">, suggested name</span>}
			</h2>
			{tx.accountType === "cash" && tx.parentId === null ? (
				<p class="text-muted">Cash · you entered this</p>
			) : (
				<p class="text-muted">
					<span class="text-lg font-semibold tabular-nums text-ink">
						{formatCents(tx.amountCents, { signed: true })}
					</span>{" "}
					· {dayLabel(tx.date, today)} · {account}
				</p>
			)}
			{/* Kept: bank text can be one long unbroken token, so it alone may break inside a word (E, DESIGN.md). */}
			{tx.rawName !== tx.displayName && (
				<p class="min-w-0 max-w-full wrap-anywhere text-sm text-muted">
					{tx.rawName}
				</p>
			)}
			{tx.pending && <PendingNote />}
			{tx.splitRemovedFromCents != null && (
				<p role="status" class="text-sm text-over">
					The bank changed this from{" "}
					{formatCents(tx.splitRemovedFromCents, { signed: true })}, so its
					split was removed.
					{unpaidBillsNote(tx.splitRemovedBills)}
				</p>
			)}
			{tx.countsInMonth && (!tx.excluded || tx.paysBill || tx.paysPlan) && (
				<p class="text-muted">
					Counts in{" "}
					{new Intl.DateTimeFormat("en-US", {
						month: "long",
						timeZone: "UTC",
					}).format(new Date(`${tx.countsInMonth}-01T00:00:00Z`))}
				</p>
			)}
			{/* The saved state, near the top, so an excluded transaction says so before any options. */}
			{tx.excluded && !tx.paysBill && !tx.paysPlan && (
				<p class="flex items-center gap-2 text-muted">
					<Icon name="transfer" class="size-5" />
					Excluded from the budget
				</p>
			)}
			{/* A payment linked to a bill counts whatever its exclusion (spec §8.5), so the panel says so. */}
			{tx.excluded && tx.paysBill && (
				<p class="text-muted">{PAYS_BILL_COUNTS}</p>
			)}
			{tx.excluded && !tx.paysBill && tx.paysPlan && (
				<p class="text-muted">{PAYS_PLAN_COUNTS}</p>
			)}
			{tx.isSplit && (
				<form
					method="post"
					action={`/transactions/${tx.id}/split/remove`}
					class="mt-4"
					hx-post={`/transactions/${tx.id}/split/remove`}
					hx-target="#page"
					hx-select="#page"
					hx-swap="outerHTML"
					hx-select-oob="#needs-count:innerHTML"
				>
					<input type="hidden" name="back" value={back} />
					<Button kind="secondary" type="submit" class="w-full">
						Remove split
					</Button>
				</form>
			)}
			<form
				method="post"
				action={`/transactions/${tx.id}`}
				class={`mt-4 flex flex-col gap-3 border-t border-rule pt-4 ${EDIT_FORM_GROUP}`}
				hx-post={`/transactions/${tx.id}`}
				hx-disable="findAll button[type=submit]"
				hx-indicator="#edit-save"
				// The Needs category count sits in the filter form, outside #page, so update it too.
				hx-select-oob="#needs-count:innerHTML"
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
			>
				<input type="hidden" name="back" value={back} />
				<input
					type="hidden"
					name="details_visible"
					value={tx.detailsVisible ? "1" : "0"}
				/>
				<input
					type="hidden"
					name="note_was"
					value={values.noteWas ?? values.note ?? ""}
				/>
				<input
					type="hidden"
					name="kind_was"
					value={values.kindWas ?? values.kind ?? ""}
				/>
				<input
					type="hidden"
					name="for_person_id_was"
					value={values.forPersonIdWas ?? values.forPersonId ?? ""}
				/>
				<input
					type="hidden"
					name="displayed_name_guess"
					value={tx.nameSuggested ? tx.displayName : ""}
				/>
				<input
					type="hidden"
					name="income_was"
					value={(values.incomeWas ?? values.income) ? "1" : "0"}
				/>
				{/* The merchant rule is offered only for an unlinked row (the chip above), so a linked row posts
				    no rule answer and a save leaves the rule alone, whatever its purchase or counting. */}
				{tx.refundOfId == null && (
					<>
						<input
							type="hidden"
							name="always_was"
							value={values.alwaysWas ? "1" : "0"}
						/>
						<input
							type="hidden"
							name="rule_category_was"
							value={values.merchantRuleWas ?? ""}
						/>
					</>
				)}
				{/* While the delete question is open there's no Save, so Enter in the name field would save the
				    form anyway; a disabled first submit button makes Enter do nothing (HTML implicit submission). */}
				{deleteConfirm && <button type="submit" disabled hidden />}
				{/* What the name field held when this panel was first drawn, so a save can tell a rename from a panel that
				    is only out of date: another tab may have named the merchant since (src/transactions/edit.ts). After
				    an error the panel is drawn again with the posted value, never the merchant's name as it is now. */}
				<input
					type="hidden"
					name="merchant_was"
					value={nameWas ?? tx.merchantName ?? ""}
				/>
				<CategoryChoice
					tx={tx}
					categories={categories}
					values={values}
					errors={errors}
					purchase={purchase}
					back={back}
					rule={
						tx.refundOfId == null
							? {
									checked: values.alwaysForMerchant,
									ruleCategory: values.alwaysWas
										? (ruleCategoryName ??
											tx.merchantRuleCategoryName ??
											undefined)
										: undefined,
								}
							: undefined
					}
				/>
				{cashValues && (
					<>
						<MoneyInput
							id="cash-edit-amount"
							name="amount"
							label="Amount"
							value={cashValues.amount}
							error={errors.amount}
						/>
						{/* Its own request, with its own indicator (not Save's), and the panel's fields go with it. htmx 4
						    sends a button's name and value only with a submit event, so hx-vals carries change_parts. */}
						{changePartsTotalCents !== undefined && (
							<Button
								kind="secondary"
								type="submit"
								name="change_parts"
								value="1"
								class="w-full"
								hx-post={`/transactions/${tx.id}`}
								hx-vals={JSON.stringify({ change_parts: "1" })}
								hx-target="#page"
								hx-select="#page"
								hx-swap="outerHTML"
								hx-select-oob="#needs-count:innerHTML"
							>
								Change the parts
							</Button>
						)}
						<TextInput
							id="cash-edit-date"
							name="date"
							label="Date"
							type="date"
							value={cashValues.date}
							max={today}
							surface="paper"
							error={errors.date}
						/>
					</>
				)}
				{/* An error keeps the section, even when no purchase is offered any more. */}
				{(refunds.length > 0 || tx.refundOfId != null || errors.refund) && (
					<details
						class="group border-t border-rule"
						open={Boolean(errors.refund)}
					>
						<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
							<span class="transition-transform group-open:rotate-90 motion-reduce:transition-none">
								<Icon name="chevron-right" class="size-5" />
							</span>
							This refunds…
						</summary>
						<div class="flex flex-col gap-3 pt-1">
							<p class="text-sm text-muted">
								{tx.displayName} purchases in the last 90 days
							</p>
							<fieldset
								class="flex flex-col gap-3"
								aria-describedby={errors.refund ? "refund-error" : undefined}
							>
								<legend class="sr-only">Purchase this refunds</legend>
								<Chip
									type="radio"
									name="refund_of"
									value=""
									checked={values.refundOfId == null}
								>
									Not linked
								</Chip>
								{refunds.map((p) => (
									<Chip
										type="radio"
										name="refund_of"
										value={String(p.id)}
										checked={values.refundOfId === p.id}
										inputClass={p.excluded ? undefined : LINKED_PURCHASE_CLASS}
									>
										{refundPurchaseLabel(p, tx.date)}
									</Chip>
								))}
							</fieldset>
							{errors.refund && (
								<p id="refund-error" role="alert" class="text-sm text-over">
									{errors.refund}
								</p>
							)}
						</div>
					</details>
				)}
				{/* A linked refund has no category of its own to make a rule from, so it has no rule tick either. */}
				{tx.merchantRuleCategoryName &&
					values.alwaysForMerchant &&
					tx.refundOfId != null && (
						<p class="text-sm text-muted">
							Remove it in Settings, under{" "}
							<a href="/settings/rules">Tally's rules</a>.
						</p>
					)}
				{/* A setting about this transaction, so a switch, not a category's pill (audit E2, decision 73). */}
				<Switch
					id="edit-exclude"
					name="excluded"
					value="1"
					label="Exclude from budget"
					hint={excludeHint(tx)}
					checked={values.excluded}
				/>
				<div class="border-t border-rule">
					<DetailRow
						id="detail-name"
						label="Name"
						value={tx.displayName}
						source={
							tx.nameFromBank ? "bank" : tx.nameSuggested ? "guess" : "person"
						}
						guessed={tx.nameSuggested || tx.nameFromBank}
						open={Boolean(errors.merchant || namePick)}
					>
						<NameChoices
							id="name"
							names={tx.nameChoices.names}
							source={tx.nameChoices.source}
							tidied={tx.nameChoices.tidied}
							rawName={
								tx.accountType === "cash" ? undefined : tx.nameChoices.rawName
							}
							picked={namePick}
							own={values.displayName ?? ""}
							ownName={tx.ownName}
							error={errors.merchant}
							rename={{
								merchant: tx.nameChoices.merchantLabel,
								total: tx.nameChoices.total,
								part: typeof tx.parentId === "number",
								owned: tx.nameChoices.owned,
								thisOwn: tx.nameChoices.thisOwn,
								// The note is drawn as if every control the edit reads were off, and the hooks hide it while one of them blocks the
								// guess (name-choices.tsx). So a purchase link counts as Not linked, and what stays out is only a split row, or a
								// category someone else set. linkHolds is the drawn purchase that keeps the refund following it with Reviewed off,
								// which Jev's review does; reviewLifts is whether ticking Reviewed lifts Plaid's exclusion, which Exclude's hook
								// reads. The hooks fold on both.
								tallyCategory:
									tx.nameChoices.tallyCategory &&
									jevCategories &&
									jevAsksAbout({
										included: true,
										isSplit: tx.isSplit === true,
										income: false,
										followsPurchase: false,
									}),
								// Exclude changes the answer only where the row isn't a bill or planned-expense payment, which counts either way.
								excludeCounts: tx.paysBill !== true && tx.paysPlan !== true,
								linkHolds:
									linkedPurchase !== undefined &&
									followsPurchaseAfterSave(tx, {
										...values,
										income: false,
										creditReviewed: false,
									}),
								reviewLifts: countsIfReviewed(true) !== countsIfReviewed(false),
								today,
								scope: nameScope,
							}}
						/>
					</DetailRow>
					<DetailRow
						id="detail-note"
						label="What it was"
						value={values.note}
						// Keyed off what is drawn, so a refused save's emptied note has no source line.
						source={
							values.note ? (noteGuessed ? "guess" : "person") : undefined
						}
						guessed={noteGuessed}
						open={Boolean(errors.note)}
					>
						<FormField id="note" label="What it was" error={errors.note}>
							{({ class: errorClass, ...a11y }) => (
								<>
									<input
										type="hidden"
										name="note_was"
										value={values.noteWas ?? values.note ?? ""}
									/>
									<textarea
										id="note"
										name="note"
										rows={2}
										class={`w-full rounded-control border border-rule bg-paper px-3 py-2 text-lg ${errorClass ?? ""}`}
										{...a11y}
									>
										{values.note ?? ""}
									</textarea>
								</>
							)}
						</FormField>
					</DetailRow>
					<DetailRow
						id="detail-kind"
						label="Kind"
						value={
							values.kind
								? (
										{
											subscription: "Subscription",
											one_off: "One-off",
											bill: "Bill",
											transfer: "Transfer",
										} as const
									)[values.kind]
								: null
						}
						source={
							values.kind ? (kindGuessed ? "guess" : "person") : undefined
						}
						guessed={kindGuessed}
						open={Boolean(errors.kind)}
					>
						<fieldset
							class="flex flex-wrap gap-2"
							aria-describedby={errors.kind ? "kind-error" : undefined}
						>
							<legend class="sr-only">Kind</legend>
							<input
								type="hidden"
								name="kind_was"
								value={values.kindWas ?? values.kind ?? ""}
							/>
							{(["subscription", "one_off", "bill", "transfer"] as const).map(
								(kind) => (
									<Chip
										type="radio"
										name="kind"
										value={kind}
										checked={values.kind === kind}
									>
										{kind === "one_off"
											? "One-off"
											: kind[0]?.toUpperCase() + kind.slice(1)}
									</Chip>
								),
							)}
							<Chip
								type="radio"
								name="kind"
								value=""
								checked={values.kind === null}
							>
								Not known
							</Chip>
						</fieldset>
						{errors.kind && (
							<p id="kind-error" role="alert" class="text-sm text-over">
								{errors.kind}
							</p>
						)}
					</DetailRow>
					<DetailRow
						id="detail-for"
						label="For"
						value={
							values.forPersonId == null
								? people.length < 2
									? "Add the people in your household"
									: null
								: forName
						}
						source={
							forName === null
								? undefined
								: forPersonGuessed
									? "guess"
									: "person"
						}
						guessed={forPersonGuessed}
						open={Boolean(errors.forPerson)}
					>
						<fieldset
							class="flex flex-wrap gap-2"
							aria-describedby={
								errors.forPerson ? "for-person-error" : undefined
							}
						>
							<legend class="sr-only">For</legend>
							<input
								type="hidden"
								name="for_person_id_was"
								value={values.forPersonIdWas ?? values.forPersonId ?? ""}
							/>
							{people.map((person) => (
								<Chip
									type="radio"
									name="for_person_id"
									value={String(person.id)}
									checked={values.forPersonId === person.id}
								>
									{person.name}
								</Chip>
							))}
							<Chip
								type="radio"
								name="for_person_id"
								value=""
								checked={values.forPersonId === null}
							>
								No one
							</Chip>
						</fieldset>
						{people.length < 2 && (
							<p class="text-sm text-muted">
								Add the people in your household.
							</p>
						)}
						{errors.forPerson && (
							<p id="for-person-error" role="alert" class="text-sm text-over">
								{errors.forPerson}
							</p>
						)}
					</DetailRow>
				</div>
				{!deleteConfirm && (
					<div class="flex flex-col items-start">
						<Button
							name="details_action"
							value="keep"
							type="submit"
							kind="secondary"
						>
							Looks right
							<span class="sr-only">, keep these details</span>
						</Button>
						<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
							Tally uses these when it picks a category.
							<WhyLink section="categorization" topic="Tally's guess" />
						</p>
					</div>
				)}
				{tx.parentId === null && !tx.isSplit && !tx.income && (
					<a
						href={`/transactions/${tx.id}/split?back=${encodeURIComponent(back)}`}
						class="flex min-h-12 items-center justify-between gap-3 border-b border-rule focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					>
						<span>Split</span>
						<span class="text-muted">
							<Icon name="chevron-right" class="size-5" />
						</span>
					</a>
				)}
				<div class="flex flex-col gap-2 border-t border-rule pt-3">
					<div {...lockRedraw}>
						<Switch
							id="edit-income"
							name="income"
							value="1"
							label="Count as income"
							checked={values.income}
							describedBy={
								showIncomeGuess
									? `income-suggestion-confidence-${tx.id}`
									: undefined
							}
						/>
					</div>
					{showIncomeGuess && (
						<p
							id={`income-suggestion-confidence-${tx.id}`}
							class="flex flex-wrap items-center gap-x-2 text-sm text-muted"
						>
							Tally's guess · {Math.round((tx.incomeConfidence ?? 0) * 100)}%
							sure
							<WhyLink section="categorization" topic="income" />
						</p>
					)}
				</div>
				{tx.amountCents < 0 && (
					<div
						class="flex flex-col gap-2 border-t border-rule pt-3"
						{...lockRedraw}
					>
						<input type="hidden" name="creditReviewedVisible" value="1" />
						<input
							type="hidden"
							name="creditReviewed_was"
							value={
								(values.creditReviewedWas ?? values.creditReviewed) ? "1" : "0"
							}
						/>
						{!tx.creditReviewed && !values.income && (
							<p class="text-sm text-muted">
								This bank credit is held out of spending until you identify it.
							</p>
						)}
						<Switch
							id="edit-credit-reviewed"
							name="creditReviewed"
							value="1"
							label="Reviewed as a refund or other non-income credit"
							checked={values.creditReviewed}
						/>
					</div>
				)}
				{tx.accountType !== "cash" && tx.parentId === null && (
					<p class="mt-2 text-sm text-muted">
						From {tx.bankName ?? tx.accountName}. Its date and amount stay as
						the bank sent them. If something's off, you can split it, exclude
						it, or count it in another month.
					</p>
				)}
				{/* Asking about a delete takes this row's place (below, in the delete form), so the sheet never
				    has two ways to leave it side by side (decision 84). */}
				{!deleteConfirm && (
					<div class="mt-2 grid grid-cols-2 gap-3">
						<Button
							href={closeHref}
							kind="secondary"
							class="w-full"
							{...closeAttrs}
						>
							Cancel
						</Button>
						<Button
							id="edit-save"
							type="submit"
							class="w-full"
							busyLabel="Saving…"
						>
							Save
						</Button>
					</div>
				)}
			</form>
			{tx.accountType === "cash" && tx.parentId === null && (
				<form
					method="post"
					action={`/transactions/${tx.id}/delete`}
					class="mt-4"
					hx-post={`/transactions/${tx.id}/delete`}
					hx-target="#page"
					hx-select="#page"
					hx-swap="outerHTML"
				>
					<input type="hidden" name="back" value={back} />
					{deleteConfirm ? (
						<>
							<input type="hidden" name="confirm" value="1" />
							<p
								id="delete-question"
								tabindex={-1}
								autofocus
								// Focused so the swap is announced with the question; it isn't a control, so no ring.
								// The bottom scroll margin brings Delete and Keep it into view with it on a phone.
								class="scroll-mb-24 text-lg outline-none"
							>
								{`Delete ${tx.displayName}, ${formatCents(tx.amountCents)}?`}
							</p>
							<div class="mt-3 grid grid-cols-2 gap-3">
								<Button type="submit" class="w-full">
									Delete
								</Button>
								{/* Keep it goes back to this entry's edit sheet, not the list. */}
								<Button
									href={editHref}
									kind="secondary"
									class="w-full"
									hx-get={editHref}
									hx-target="#page"
									hx-select="#page"
									hx-swap="outerHTML"
								>
									Keep it
								</Button>
							</div>
						</>
					) : (
						<Button kind="text" type="submit">
							Delete cash transaction
						</Button>
					)}
				</form>
			)}
		</BottomSheet>
	);
}

import type { NameSource } from "../transactions/name-suggestions";
import {
	ALL_LATER_LINE,
	allLabel,
	allNotes,
	allUpdateCount,
	type OwnedRow,
	otherTransactionsLine,
} from "../transactions/rename";
import { Icon } from "./icons";
import { TextInput } from "./text-input";
import { WhyLink } from "./why-link";

/** The longest name a person may type, as in the edit panel's rename (src/transactions/edit.ts). */
export const MAX_OWN_NAME = 80;

/**
 * How a suggested name looks wherever it stands in for a chosen one: a dashed underline, the "not decided
 * yet" mark (DESIGN.md), plus a screen-reader word because an underline says nothing aloud (P29 A).
 */
export const SUGGESTED_NAME_CLASS =
	"underline decoration-muted decoration-dashed underline-offset-4";

/**
 * In the list, before a name Tally guessed (P87 B, decision 80): the sparkles icon, and "Tally's guess"
 * read out, since an icon says nothing aloud.
 */
export function GuessMark() {
	return (
		<>
			<Icon name="sparkles" class="size-4 shrink-0" />
			<span class="sr-only">Tally's guess: </span>
		</>
	);
}

/**
 * In the list, for a name the bank sent (P87 B): no icon, only the words for a screen reader, since
 * the dashed underline says "not decided yet" to the eye alone.
 */
export function BankMark() {
	return <span class="sr-only">From your bank: </span>;
}

/** The value a suggested name's choice posts: the name itself, so a stale page can't pick another one. */
export const pickValue = (name: string) => `s:${name}`;
/** The value of "The store's own name" (decision 101): the bank's text tidied. */
export const STORE_VALUE = "store";
/** The value of "Type your own" (decision 101): the name typed in the field. */
export const OWN_VALUE = "own";
/** The class every Name row choice carries; the Rename list shows while one of them is ticked. */
export const NAME_PICK_CLASS = "name-pick";
/** The class of the "Type your own" radio: the field under it is shown while it is ticked. */
export const OWN_PICK_CLASS = "name-own";
/**
 * The edit panel's form: its category, Exclude, Income, refund and merchant rule tick (MerchantRuleTick) controls fold the re-guess
 * note under This one only away once they change (CSS only), so it is a named group that NameChoices' and the Chips'
 * unnamed `group` don't meet.
 */
export const EDIT_FORM_GROUP = "group/edit";
/**
 * The class of the Name row choice whose name the save would treat as no rename (the route's guard): the store's
 * tidied name, or a suggested name, equal to the row's own name. The re-guess note folds on it (GUESS_AGAIN_FOLDS).
 */
export const SAME_NAME_CLASS = "name-same";
/**
 * The class of a "This refunds…" choice that links a purchase which isn't excluded (the one the save counts the refund
 * against). The re-guess note's link hooks read it; "Not linked" carries none, so picking it never folds the note.
 */
export const LINKED_PURCHASE_CLASS = "linked-purchase";
/**
 * The class of the category chip Tally picked for the row, the one it has when the panel opens. The note folds while any
 * other category, or New category, is ticked, since the save posts that one and keeps it.
 */
export const TALLY_CATEGORY_CLASS = "tally-category";

/**
 * In the list, for a name Tally guessed (P87 B, decision 80): the sparkles icon, "Tally's guess" under the
 * name, and a Why? to the page that explains it. The bank's own name: only "From your bank", in muted words,
 * with nothing to explain. `id` names the words, so each choice says where its name came from when it is read.
 */
function SourceLine({ id, source }: { id: string; source: NameSource }) {
	if (source === "bank")
		return (
			<p id={id} class="text-sm text-muted">
				From your bank
			</p>
		);
	return (
		<div class="flex flex-wrap items-center gap-x-2 text-sm">
			<span id={id} class="inline-flex items-center gap-1.5 text-ink">
				<Icon name="sparkles" class="size-4" />
				Tally's guess
			</span>
			<WhyLink section="names" topic="Tally's guess" />
		</div>
	);
}

/**
 * A muted line under a choice's words. A note given with `class` carries it too, for a hook of its own
 * (the re-guess note folds away with the edit form's controls).
 */
type ChoiceNote = string | { text: string; class: string };

/**
 * One choice on its own line (decision 101): a real radio, 44px tall, its words beside it and any muted
 * lines under them. The radio carries NAME_PICK_CLASS when it is a Name row choice, which is what shows the
 * Rename list.
 */
function Choice({
	name,
	value,
	checked,
	pick = false,
	radioClass = "",
	autofocus = false,
	describedBy,
	notes = [],
	children,
}: {
	name: string;
	value: string;
	checked: boolean;
	/** A choice of the Name row, which opens the Rename list when ticked. */
	pick?: boolean;
	/** Another class the radio carries, for a hook the Name group's CSS reads (OWN_PICK_CLASS). */
	radioClass?: string;
	autofocus?: boolean;
	describedBy?: string;
	notes?: ChoiceNote[];
	children: string;
}) {
	return (
		<label class="flex min-h-11 cursor-pointer items-start gap-3 py-2 text-base text-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
			<input
				type="radio"
				name={name}
				value={value}
				checked={checked}
				autofocus={autofocus}
				aria-describedby={describedBy}
				class={`mt-1 size-5 shrink-0 accent-ink ${pick ? NAME_PICK_CLASS : ""} ${radioClass}`}
			/>
			<span class="flex min-w-0 flex-col wrap-anywhere">
				<span>{children}</span>
				{notes.map((note) => {
					const { text, class: hook = "" } =
						typeof note === "string" ? { text: note, class: "" } : note;
					return (
						<span class={`text-sm text-muted ${hook}`.trim()}>{text}</span>
					);
				})}
			</span>
		</label>
	);
}

/** The facts the Rename list is worded from (decision 101), read from the merchant's transactions. */
export type RenameFacts = {
	/** The merchant as the list shows it: its chosen name, else the store's own name. */
	merchant: string;
	/** Transactions from the merchant, split purchases counted once, this one included unless it is a split part (its purchase is counted). */
	total: number;
	/** A split part: it isn't among `total`, so "This one only" counts every one of them as another. */
	part?: boolean;
	/** Other transactions from the merchant that have a name of their own. */
	owned: OwnedRow[];
	/** This transaction's own name, when it has one. */
	thisOwn: string | null;
	/**
	 * Whether a guess could happen in this edit: Tally picked this transaction's category (or it has none) and Jev can be
	 * asked, read as if every control the edit reads were off. The hooks hide the note while a control blocks the guess.
	 * "This one only" makes Tally guess again.
	 */
	tallyCategory: boolean;
	/** Whether Exclude changes whether Jev can be asked about the row: false for a payment linked to a bill, which counts whatever its exclusion. */
	excludeCounts: boolean;
	/**
	 * Whether the drawn purchase keeps the refund following it with Reviewed unticked: Jev's review holds it, and only
	 * unlinking changes that. Then a purchase ticked holds the note (LINK_HOLDS_FOLDS).
	 */
	linkHolds: boolean;
	/** Today's date, for the dates of the other own names. */
	today: string;
	/** The scope that is ticked: "all" when the merchant is renamed, otherwise "this one only". */
	scope: "one" | "all";
	/** Override only for isolated catalog specimens, so their radio groups stay apart. */
	scopeName?: string;
};

/**
 * The re-guess note's hooks (CSS only, decision 101, read from EDIT_FORM_GROUP). The note is drawn whenever a guess could
 * happen in this edit (the route's tallyCategory, read as if every control were off), and these hooks hide it while a
 * control the save reads blocks that guess: the save then keeps the person's category, or Jev isn't asked. A ticked
 * checkbox hides it whether it was drawn ticked or not, so unticking it shows the note again. The category hides it while
 * any other choice is ticked, and a purchase hides it once it is picked over the one drawn. Each hook is a literal class,
 * so Tailwind compiles it; LINKED_PURCHASE_CLASS and TALLY_CATEGORY_CLASS are written into the hooks by their literal text,
 * which must stay in step with those constants. Where :has() isn't supported the hooks do nothing, so the note stays as
 * it was drawn; that is never seen, since the Rename list itself needs :has() to open.
 *
 * Every posted field the re-guess reads at save time (oneOffGuessesAgain, the route's `row`, followsPurchaseAfterSave
 * and parseEdit), and the hook that covers it or why it needs none:
 * - category (a radio; NewCategoryChip and SuggestedCategoryChip post it too): covered here, by any choice other than the
 *   row's own category (TALLY_CATEGORY_CLASS). A disabled category (a refund that follows its purchase) posts nothing, so
 *   `:enabled` exempts it: its drawn chip is the purchase's category, not the row's. new_category_name counts only while
 *   category is "new", so the same hook covers it.
 * - excluded (a checkbox): EXCLUDE_FOLDS, while excludeCounts holds. A bill payment counts whatever its exclusion.
 * - income (a checkbox): covered here, while it is ticked.
 * - refund_of (a radio): covered here. A purchase that isn't excluded (LINKED_PURCHASE_CLASS) is what the refund follows,
 *   and linking one includes the row. Choosing a purchase other than the one drawn hides the note; "Not linked" never
 *   does, so picking it shows the note again. While the drawn link holds (linkHolds), any purchase ticked hides it.
 * - creditReviewed (a checkbox): covered here, and only with a linked purchase ticked: a refund that isn't linked doesn't
 *   follow, whatever its review. creditReviewed_was is the state it was drawn in, so it needs no hook.
 * - name_pick (a radio): covered here, by the choice SAME_NAME_CLASS marks. Ticking another name brings the note back.
 * - merchant (the typed name under Type your own): no hook. CSS can't read typed text, so retyping the row's own name
 *   keeps the note, and the save is still right: the route keeps the row's name. This is the one known limit.
 * - always (the merchant rule tick, MerchantRuleTick): covered here, while it is ticked. Ticking it makes the save keep the
 *   category, since the rule settles it. always_was and rule_category_was are the state it was drawn in, so they need no hook.
 * - name_scope: no hook. The note is a line under This one only and describes that choice whichever scope is ticked.
 * - Hidden or server-side, so no hook: merchant_was, jevCategories, paysBill, isSplit and the stored category.
 *   details_action=keep and displayed_name_guess: with nothing ticked the Rename list is hidden, and the save names
 *   Tally's guess for All, so no note shows.
 * - The rest parseEdit reads (note, note_was, kind, kind_was, for_person_id, for_person_id_was, details_visible)
 *   doesn't feed the re-guess.
 */
const GUESS_AGAIN_FOLDS = [
	"group-has-[input[name=category]:checked:enabled:not(.tally-category)]/edit:hidden",
	"group-has-[input[name=income]:checked]/edit:hidden",
	"group-has-[.linked-purchase:checked:not([checked])]/edit:hidden",
	"group-has-[input[name=creditReviewed]:checked]/edit:group-has-[.linked-purchase:checked]/edit:hidden",
	"group-has-[.name-same:checked]/edit:hidden",
	"group-has-[input[name=always]:checked]/edit:hidden",
];
/** Exclude blocks the guess unless the row pays a bill (excludeCounts). */
const EXCLUDE_FOLDS = ["group-has-[input[name=excluded]:checked]/edit:hidden"];
/** While the drawn link holds (linkHolds), any linked purchase ticked is the refund following it, so it hides the note. */
const LINK_HOLDS_FOLDS = ["group-has-[.linked-purchase:checked]/edit:hidden"];

/** The classes of the re-guess note under This one only: the hooks that apply to the row it is drawn for. */
function guessAgainFolds({
	excludeCounts,
	linkHolds,
}: Pick<RenameFacts, "excludeCounts" | "linkHolds">): string {
	return [
		...GUESS_AGAIN_FOLDS,
		...(excludeCounts ? EXCLUDE_FOLDS : []),
		...(linkHolds ? LINK_HOLDS_FOLDS : []),
	].join(" ");
}

/**
 * The Rename list (decision 101, Name row round 2 A): "This one only" (ticked by default) and "All N from
 * <merchant>", shown only while a name is ticked, which the Name group's CSS does with `group-has`. Each
 * choice says what it changes in muted words under it, so the counts are never a surprise.
 */
export function RenameChoices({ rename }: { rename: RenameFacts }) {
	const {
		merchant,
		total,
		part = false,
		owned,
		thisOwn,
		tallyCategory,
		excludeCounts,
		linkHolds,
		today,
		scope,
		scopeName = "name_scope",
	} = rename;
	const others = otherTransactionsLine(total, { part });
	const count = allUpdateCount({ total, owned });
	const allRows = count >= 2;
	return (
		<div class="hidden flex-col gap-1 border-t border-rule pt-3 group-has-[.name-pick:checked]:flex">
			<fieldset class="flex flex-col">
				<legend class="pb-1 text-base text-ink">Rename</legend>
				<Choice
					name={scopeName}
					value="one"
					checked={scope !== "all"}
					notes={[
						...(others ? [others] : []),
						...(tallyCategory
							? [
									{
										text: "Tally guesses its category again.",
										class: guessAgainFolds({ excludeCounts, linkHolds }),
									},
								]
							: []),
					]}
				>
					This one only
				</Choice>
				<Choice
					name={scopeName}
					value="all"
					checked={scope === "all"}
					notes={[
						...allNotes({ thisOwn, owned, today }),
						...(allRows ? [ALL_LATER_LINE] : []),
					]}
				>
					{allLabel({ count, merchant, thisOwn: thisOwn !== null })}
				</Choice>
			</fieldset>
		</div>
	);
}

/**
 * The Name row (P29 A, decision 64, decision 101): one ticked list with one choice per line. Each suggested
 * name, with where it came from under it; the store's own name (the bank's text tidied) with "The bank says"
 * under it; and "Type your own", which reveals the field. Nothing is ticked to start with, so saving the panel
 * for another reason never renames anything. With `rename`, the Rename list follows the ticked choice (the
 * edit panel); Settings' Merchant names review has none. Choosing a radio is the whole interaction, so it
 * works without JavaScript.
 */
export function NameChoices({
	id,
	radioName = "name_pick",
	names,
	source,
	tidied,
	rawName,
	picked,
	own = "",
	ownName = null,
	error,
	focusFirst = false,
	rename,
}: {
	/** Unique on the page: the radio group's and the field's ids start with it. */
	id: string;
	/** Override only for isolated, non-form catalog specimens. */
	radioName?: string;
	/** The suggested names still waiting. */
	names: string[];
	/** Where they came from: Tally guessed them, or the bank sent Plaid's name. */
	source: NameSource;
	/** The store's own name: the bank's text as the list shows it without a choice. */
	tidied: string;
	/**
	 * The bank's text as it was sent, which the store's own line quotes. Left out for a cash entry, which no
	 * bank sent; the line is also left out when the bank's text is the tidied name already.
	 */
	rawName?: string;
	/** The choice that was ticked, as it posted (after a failed save). */
	picked?: string | null;
	/** What was typed in the field. */
	own?: string;
	/**
	 * The name the row shows as its own (tx.ownName: a split part's inherited name counts). A choice of that name is
	 * no rename to the save, so it carries SAME_NAME_CLASS. Left out where the row has no own name.
	 */
	ownName?: string | null;
	error?: string;
	focusFirst?: boolean;
	/** The Rename list's facts; left out where a name is never for one transaction. */
	rename?: RenameFacts;
}) {
	const sourceId = `${id}-source`;
	// An error about the typed name sits under its field, which shows only while "Type your own" is ticked.
	// Every other error (nothing ticked, a stale suggestion) sits under the list, where it is always visible.
	const ownPicked = picked === OWN_VALUE;
	const ownError = ownPicked ? error : undefined;
	const choiceError = ownPicked ? undefined : error;
	return (
		<fieldset
			class="group flex flex-col"
			aria-describedby={
				error ? (ownPicked ? `${id}-own-error` : `${id}-error`) : undefined
			}
		>
			<legend class="pb-1 text-base text-ink">Name</legend>
			{names.map((name, index) => (
				<div class="flex flex-col">
					<Choice
						name={radioName}
						value={pickValue(name)}
						checked={picked === pickValue(name)}
						pick
						autofocus={focusFirst && index === 0}
						describedBy={`${sourceId}-${index}`}
						radioClass={name === ownName ? SAME_NAME_CLASS : ""}
					>
						{name}
					</Choice>
					<div class="pb-1 pl-8">
						<SourceLine id={`${sourceId}-${index}`} source={source} />
					</div>
				</div>
			))}
			<Choice
				name={radioName}
				value={STORE_VALUE}
				checked={picked === STORE_VALUE}
				pick
				radioClass={tidied === ownName ? SAME_NAME_CLASS : ""}
				notes={
					rawName && rawName !== tidied ? [`The bank says ${rawName}`] : []
				}
			>
				{tidied}
			</Choice>
			<Choice
				name={radioName}
				value={OWN_VALUE}
				checked={picked === OWN_VALUE}
				pick
				radioClass={OWN_PICK_CLASS}
			>
				Type your own
			</Choice>
			{choiceError && (
				<p id={`${id}-error`} role="alert" class="text-sm text-over">
					{choiceError}
				</p>
			)}
			<div class="hidden pl-8 group-has-[.name-own:checked]:block">
				<TextInput
					id={`${id}-own`}
					label="Your own name"
					name="merchant"
					value={own}
					maxlength={MAX_OWN_NAME}
					autocomplete="off"
					surface="paper"
					error={ownError}
				/>
			</div>
			{rename && <RenameChoices rename={rename} />}
		</fieldset>
	);
}

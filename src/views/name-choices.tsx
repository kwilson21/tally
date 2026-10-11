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
 * One choice on its own line (decision 101): a real radio, 44px tall, its words beside it and any muted
 * lines under them. The radio carries NAME_PICK_CLASS when it is a Name row choice, which is what shows the
 * Rename list.
 */
function Choice({
	name,
	value,
	checked,
	pick = false,
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
	autofocus?: boolean;
	describedBy?: string;
	notes?: string[];
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
				class={`mt-1 size-5 shrink-0 accent-ink ${pick ? NAME_PICK_CLASS : ""}`}
			/>
			<span class="flex min-w-0 flex-col wrap-anywhere">
				<span>{children}</span>
				{notes.map((note) => (
					<span class="text-sm text-muted">{note}</span>
				))}
			</span>
		</label>
	);
}

/** The facts the Rename list is worded from (decision 101), read from the merchant's transactions. */
export type RenameFacts = {
	/** The merchant as the list shows it: its chosen name, else the store's own name. */
	merchant: string;
	/** Transactions from the merchant, split purchases counted once, this one included. */
	total: number;
	/** Other transactions from the merchant that have a name of their own. */
	owned: OwnedRow[];
	/** This transaction's own name, when it has one. */
	thisOwn: string | null;
	/** Tally picked this transaction's category, or it has none: "This one only" makes Tally guess again. */
	tallyCategory: boolean;
	/** Today's date, for the dates of the other own names. */
	today: string;
	/** The scope that is ticked: "all" when the merchant is renamed, otherwise "this one only". */
	scope: "one" | "all";
	/** Override only for isolated catalog specimens, so their radio groups stay apart. */
	scopeName?: string;
};

/**
 * The Rename list (decision 101, Name row round 2 A): "This one only" (ticked by default) and "All N from
 * <merchant>", shown only while a name is ticked, which the Name group's CSS does with `group-has`. Each
 * choice says what it changes in muted words under it, so the counts are never a surprise.
 */
export function RenameChoices({ rename }: { rename: RenameFacts }) {
	const {
		merchant,
		total,
		owned,
		thisOwn,
		tallyCategory,
		today,
		scope,
		scopeName = "name_scope",
	} = rename;
	const others = otherTransactionsLine(total);
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
						...(tallyCategory ? ["Tally guesses its category again."] : []),
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
	error?: string;
	focusFirst?: boolean;
	/** The Rename list's facts; left out where a name is never for one transaction. */
	rename?: RenameFacts;
}) {
	const sourceId = `${id}-source`;
	return (
		<fieldset
			class="group flex flex-col"
			aria-describedby={error ? `${id}-own-error` : undefined}
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
			>
				Type your own
			</Choice>
			<div class="pl-8">
				<TextInput
					id={`${id}-own`}
					label="Your own name"
					name="merchant"
					value={own}
					maxlength={MAX_OWN_NAME}
					autocomplete="off"
					surface="paper"
					error={error}
				/>
			</div>
			{rename && <RenameChoices rename={rename} />}
		</fieldset>
	);
}

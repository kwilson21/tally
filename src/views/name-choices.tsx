import type { NameSource } from "../transactions/name-suggestions";
import { Chip } from "./chip";
import { Icon } from "./icons";
import { TextInput } from "./text-input";
import { WhyLink } from "./why-link";

/**
 * How a suggested name looks wherever it stands in for a chosen one: a dashed underline, the "not decided
 * yet" mark (DESIGN.md), plus a screen-reader word because an underline says nothing aloud (P29 A).
 */
export const SUGGESTED_NAME_CLASS =
	"underline decoration-muted decoration-dashed underline-offset-4";

/** The longest name a person may type, as in the edit panel's rename (src/transactions/edit.ts). */
export const MAX_OWN_NAME = 80;

/** The value a suggested name's chip posts: the name itself, so a stale page can't pick another one. */
export const pickValue = (name: string) => `s:${name}`;
/** The value of "Keep the bank's name". */
export const KEEP_VALUE = "keep";

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

/**
 * Under the suggested names in the edit panel and on the review screen (P87 B). Tally's guess: the
 * same icon with "Tally's guess", then a Why? to the page that explains it. The bank's own name: only
 * "From your bank", in muted words, with nothing to explain. `id` names the words, so each chip says
 * where its name came from when it is read.
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
 * Choosing a merchant's name (P29 A, decision 64): up to three suggested names as chips with where
 * they came from under them (P87 B: "Tally's guess" or "From your bank"), keeping the bank's (tidied)
 * name, or a name of your own. Nothing
 * is chosen to start with, so saving the form for another reason never renames the merchant; a name
 * typed in the field wins over a chip. It posts `name_pick` (a chip's value) and `merchant` (the typed
 * name); each suggestion is a plain radio, so it works without JavaScript.
 */
export function NameChoices({
	id,
	radioName = "name_pick",
	names,
	source,
	tidied,
	count,
	picked,
	own = "",
	error,
	focusFirst = false,
}: {
	/** Unique on the page: the radio group's and the field's ids start with it. */
	id: string;
	/** Override only for isolated, non-form catalog specimens. */
	radioName?: string;
	/** The suggested names, at most three. */
	names: string[];
	/** Where they came from: Tally guessed them, or the bank sent Plaid's name. */
	source: NameSource;
	/** The bank's text as the list shows it without a choice. */
	tidied: string;
	/** How many transactions the name applies to. */
	count: number;
	/** The chip that was chosen, as it posted (after a failed save). */
	picked?: string | null;
	/** What was typed in the field. */
	own?: string;
	error?: string;
	focusFirst?: boolean;
}) {
	const sourceId = `${id}-source`;
	return (
		<fieldset
			class="flex flex-col gap-2"
			aria-describedby={error ? `${id}-own-error` : undefined}
		>
			<legend class="text-base text-ink">Name</legend>
			<div class="flex flex-col gap-1">
				<div class="flex flex-wrap gap-2">
					{names.map((name, index) => (
						<Chip
							type="radio"
							name={radioName}
							value={pickValue(name)}
							checked={picked === pickValue(name)}
							describedBy={sourceId}
							autofocus={focusFirst && index === 0}
						>
							{name}
						</Chip>
					))}
				</div>
				<SourceLine id={sourceId} source={source} />
			</div>
			<div class="flex flex-wrap gap-2 pt-1">
				<Chip
					type="radio"
					name={radioName}
					value={KEEP_VALUE}
					checked={picked === KEEP_VALUE}
				>
					Keep “{tidied}”
				</Chip>
			</div>
			<TextInput
				id={`${id}-own`}
				label="Or your own"
				name="merchant"
				value={own}
				hint={`A name typed here is used instead of any name above. ${count === 1 ? "For the 1 transaction from this merchant." : `For all ${count} transactions from this merchant.`}`}
				maxlength={MAX_OWN_NAME}
				autocomplete="off"
				surface="paper"
				error={error}
			/>
		</fieldset>
	);
}

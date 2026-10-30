import { Icon } from "./icons";

/**
 * The edit panel's merchant rule tick (#353, decision 101): a plain row above Save, with Select mode's round
 * mark, in place of the "Always for this merchant" pill. Unticked by default. Its hint says what the rule is
 * when one matches this transaction (`ruleCategory`, given only then), and otherwise that unticking changes
 * just this one. The input keeps the name `always` the form has always posted, so the save (parseEdit) and
 * the re-guess note's hooks (name-choices.tsx) read it unchanged. The label is the named group `group/rule`, so its
 * check reads only this checkbox: the edit panel draws the row inside FoldedRow's `details.group`, where a checked
 * category radio would match a bare `group` (#701).
 */
export function MerchantRuleTick({
	merchant,
	checked,
	ruleCategory,
	id = "merchant-rule",
}: {
	/** The store's name (tx.storeName), never a transaction's own name: the rule is the store's. */
	merchant: string;
	/** Ticked when a rule already matches this transaction, or when a person ticks it. */
	checked: boolean;
	/** The rule's category name, when a rule matches this transaction as the panel opened (or as a redraw kept it). */
	ruleCategory?: string;
	/** Unique on the page: the title and the hint take `${id}-title` and `${id}-hint`, and the checkbox is named by the title and described by the hint. */
	id?: string;
}) {
	const hint = ruleCategory
		? `${merchant} is always ${ruleCategory}. Untick it and save to remove the rule.`
		: "Leave it unticked to change just this one.";
	return (
		<label class="group/rule flex min-h-11 cursor-pointer items-start gap-3 py-2 text-base text-ink has-[:focus-visible]:[&_.selection-mark]:outline-2 has-[:focus-visible]:[&_.selection-mark]:outline-offset-2 has-[:focus-visible]:[&_.selection-mark]:outline-accent">
			<input
				class="peer sr-only"
				type="checkbox"
				name="always"
				value="1"
				checked={checked}
				aria-labelledby={`${id}-title`}
				aria-describedby={`${id}-hint`}
			/>
			<span class="selection-mark mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border border-muted peer-checked:border-ink peer-checked:bg-band">
				<span class="hidden group-has-[:checked]/rule:flex">
					<Icon name="check" class="size-4" />
				</span>
			</span>
			{/* Kept: a name a person typed can be one long unbroken token, so it alone may break inside a word (E, DESIGN.md). */}
			<span class="flex min-w-0 flex-col wrap-anywhere">
				<span id={`${id}-title`}>
					Use this category for {merchant} from now on
				</span>
				<span id={`${id}-hint`} class="text-sm text-muted">
					{hint}
				</span>
			</span>
		</label>
	);
}

import { Chip } from "./chip";
import { Icon } from "./icons";
import { TextInput } from "./text-input";

/**
 * The fieldset that holds a category choice: give it `group/category`, so the name field opens while the
 * New category chip is chosen and folds away when another chip is (CSS only, decision 101).
 */
export const NEW_CATEGORY_GROUP = "group/category";

/**
 * The last category chip, "New category" (P67 A, redesign A): a chip like the others, plus icon and
 * terracotta text. Choosing it opens the name field under the chips (NewCategoryName).
 */
export function NewCategoryChip({
	checked = false,
	name = "category",
}: {
	checked?: boolean;
	/** The radio group's name; the catalog gives each state its own, so their radios don't share one group. */
	name?: string;
}) {
	return (
		<Chip
			type="radio"
			name={name}
			value="new"
			checked={checked}
			icon={<Icon name="plus" class="size-4 text-accent" />}
		>
			<span class="text-accent">New category</span>
		</Chip>
	);
}

/**
 * The New category name field, under the chips. It shows only while the New category chip is chosen; it
 * stays drawn where :has() isn't supported, so a name can still be typed there. A typed name counts only
 * while that chip is chosen (the save checks the choice first).
 */
export function NewCategoryName({
	id,
	name = "new_category_name",
	value = "",
	hint,
	error,
}: {
	id: string;
	name?: string;
	value?: string;
	hint: string;
	error?: string;
}) {
	return (
		<div class="supports-[selector(:has(*))]:hidden supports-[selector(:has(*))]:group-has-[input[value=new]:checked]/category:block">
			<TextInput
				id={id}
				name={name}
				label="New category name"
				value={value}
				hint={hint}
				error={error}
				autocomplete="off"
				maxlength={40}
				surface="paper"
			/>
		</div>
	);
}

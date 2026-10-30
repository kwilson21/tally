import type { Child } from "hono/jsx";
import { CategoryIcon } from "./category";
import { Chip } from "./chip";
import { TALLY_CATEGORY_CLASS } from "./name-choices";
import { NewCategoryChip } from "./new-category-choice";

/**
 * A category choice as a grid (P120 B, #498): the categories as radio chips in two equal columns, so a person
 * sees one category picker everywhere (the edit panel and Organize's Set category sheet). The edit panel ends
 * it with New category (decision 101), and `leading` is a cell before the categories, such as Tally's guess.
 * One `name` groups every radio, and `required` makes the first category's group required (Organize).
 */
export function CategoryGrid({
	categories,
	name = "category",
	checkedId = null,
	tallyId = null,
	leading,
	newCategory = false,
	newChecked = false,
	required = false,
}: {
	categories: { id: number; name: string; icon: string; color: string }[];
	name?: string;
	/** The category that's checked, if any. */
	checkedId?: number | null;
	/** The category Tally picked for the row, which keeps its Tally class (the panel's note folds on it). */
	tallyId?: number | null;
	leading?: Child;
	/** Whether New category is the last cell (the edit panel's choice, never Organize's). */
	newCategory?: boolean;
	newChecked?: boolean;
	required?: boolean;
}) {
	return (
		<div class="grid grid-cols-2 gap-2">
			{/* The leading cell (the guess) takes both columns, so its words never wrap in a narrow half. */}
			{leading && <div class="col-span-2 min-w-0">{leading}</div>}
			{categories.map((cat, index) => (
				<Chip
					type="radio"
					name={name}
					value={String(cat.id)}
					checked={cat.id === checkedId}
					required={required && index === 0}
					inputClass={cat.id === tallyId ? TALLY_CATEGORY_CLASS : undefined}
					icon={<CategoryIcon icon={cat.icon} color={cat.color} />}
				>
					{cat.name}
				</Chip>
			))}
			{newCategory && <NewCategoryChip checked={newChecked} name={name} />}
		</div>
	);
}

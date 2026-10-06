import { Chip } from "./chip";
import { Icon } from "./icons";

/** Shared dashed category guess: a row label distinguishes a new category; a chip is chosen by a person. */
export function MaybeCategory({
	name,
	kind,
}: {
	name: string;
	kind: "new" | "category";
}) {
	return (
		<span class="inline-flex min-h-11 items-center gap-1 truncate rounded-control border border-dashed border-ink px-2 text-sm text-ink">
			<Icon name="circle-dashed" class="size-4" />
			Maybe {kind === "new" ? "new: " : ""}
			{name}
		</span>
	);
}

/** P32 A: first option in the category field, explicitly marked as a suggestion. */
export function SuggestedCategoryChip({
	name,
	value,
	sure,
	checked = false,
}: {
	name: string;
	value: string;
	sure: number;
	checked?: boolean;
}) {
	return (
		<span class="relative inline-flex rounded-full border border-dashed border-ink">
			<Chip type="radio" name="category" value={value} checked={checked}>
				{name} <span class="text-muted">· Suggested</span>
			</Chip>
			<span class="sr-only">Tally's guess · {sure}% sure</span>
		</span>
	);
}

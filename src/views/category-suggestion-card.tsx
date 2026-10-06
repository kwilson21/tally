import type { PendingSuggestion } from "../db/category-suggestions";
import { Button } from "./button";
import { Icon } from "./icons";
import { SelectableTransactionRow } from "./selectable-transaction-row";
import { TextInput } from "./text-input";
import { WhyLink } from "./why-link";

/** P30 A: an open dashed card where a person chooses which transactions make the new category. */
export function CategorySuggestionCard({
	suggestion,
	error,
	ticked,
	notes,
}: {
	suggestion: PendingSuggestion;
	error?: string;
	ticked?: number[];
	notes?: Record<number, string>;
}) {
	return (
		<details
			class="mt-3 rounded-control border border-dashed border-ink px-3"
			data-suggestion={suggestion.id}
			open
		>
			<summary class="flex min-h-11 list-none items-center gap-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
				<Icon name="tag" class="size-6" />
				<span class="min-w-0 flex-1">
					<span class="block text-lg">Suggested: {suggestion.name}</span>
					<span class="block text-sm text-muted">
						Untick any that don't belong.
					</span>
				</span>
			</summary>
			{error && (
				<p role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
			<form
				method="post"
				action={`/settings/suggestions/${suggestion.id}/create`}
				hx-post={`/settings/suggestions/${suggestion.id}/create`}
				hx-target="#categories"
				hx-select="#categories"
				hx-swap="outerHTML"
				class="pb-2"
			>
				<ul class="mt-2 divide-y divide-rule border-t border-rule">
					{suggestion.rows.map((row) => {
						const checked = ticked ? ticked.includes(row.id) : true;
						return (
							<SelectableTransactionRow
								row={row}
								checked={checked}
								after={
									<>
										<input type="hidden" name="shown" value={row.id} />
										<div class="hidden supports-[selector(:has(*))]:group-has-[input[type=checkbox]:not(:checked)]/tx:block">
											<TextInput
												id={`note-${row.id}`}
												name={`note_${row.id}`}
												label={`A note for ${row.displayName} (optional)`}
												value={notes?.[row.id] ?? ""}
												maxlength={500}
												placeholder="Only used if you untick it"
												hint="Tally sorts it again right away, with your note."
												surface="paper"
												class="w-full"
											/>
										</div>
									</>
								}
							/>
						);
					})}
				</ul>
				<div class="flex flex-wrap items-center gap-2 py-3">
					<Button kind="secondary" type="submit" name="action" value="create">
						Create {suggestion.name}
					</Button>
					<Button
						kind="text"
						type="submit"
						formaction={`/settings/suggestions/${suggestion.id}/dismiss`}
						hx-post={`/settings/suggestions/${suggestion.id}/dismiss`}
						hx-target="#categories"
						hx-select="#categories"
						hx-swap="outerHTML"
					>
						Dismiss
					</Button>
					<WhyLink section="categorization" topic="suggested categories" />
				</div>
			</form>
		</details>
	);
}

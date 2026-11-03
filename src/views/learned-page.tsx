import type { LearnedLine } from "../db/learned-lines";
import { Button } from "./button";
import { CategoryIcon } from "./category";
import { EmptyState } from "./empty-state";
import { SubpageHead } from "./settings-pages";

/**
 * Settings' "What Tally has learned" page (decisions 156 and 162): under its SubpageHead, the intro, then one bordered
 * line for each learned text, "Netflix.com → Entertainment", with "From N of your answers" and a quiet Forget. Empty, it
 * says Nothing yet. The root is #page, the swap target of a Forget and of its Undo's toast. `error` is a Forget refused.
 */
export function LearnedPage({
	lines,
	error,
	id = "page",
	titleId = "learned-title",
}: {
	lines: LearnedLine[];
	error?: string;
	/** The section's id: "page" in the app, so a swap finds it; the catalog gives each state its own. */
	id?: string;
	/** The h1's id, which the section's aria-labelledby names. */
	titleId?: string;
}) {
	return (
		<section id={id} aria-labelledby={titleId} class="lg:max-w-3xl">
			<SubpageHead title="What Tally has learned" titleId={titleId} />
			{error && (
				<p role="alert" class="mt-3 text-sm text-over">
					{error}
				</p>
			)}
			<p class="mt-1 text-muted">
				Tally files these the way you chose them. Forget one and Tally goes back
				to guessing.
			</p>
			{lines.length === 0 ? (
				<div class="mt-4">
					<EmptyState
						kind="add"
						sentence="Nothing yet"
						hint="Answer a few Maybes and what you choose shows up here."
					/>
				</div>
			) : (
				<ul class="mt-4 flex flex-col gap-2">
					{lines.map((line) => {
						const title = `${line.name} → ${line.categoryName}`;
						return (
							<li class="flex min-h-16 items-center gap-4 rounded-control border border-rule bg-paper px-4 py-2">
								<CategoryIcon icon={line.icon} color={line.color} />
								<span class="min-w-0 flex-1">
									<span class="block text-lg leading-6">{title}</span>
									<span class="block leading-6 text-muted">
										{`From ${line.answers} of your answers`}
									</span>
								</span>
								<form
									method="post"
									action="/settings/learned/forget"
									hx-post="/settings/learned/forget"
									hx-disable="findAll button[type=submit]"
									hx-target={`#${id}`}
									hx-select={`#${id}`}
									hx-swap="outerHTML"
								>
									<input type="hidden" name="text" value={line.cleanedText} />
									<Button type="submit" kind="quiet" class="shrink-0">
										Forget<span class="sr-only"> {title}</span>
									</Button>
								</form>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}

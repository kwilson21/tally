import type { LearnedLine } from "../db/learned-lines";
import { Button } from "./button";
import { CategoryIcon } from "./category";
import { EmptyState } from "./empty-state";
import { SelectField } from "./select-field";
import { SubpageHead } from "./settings-pages";

/**
 * Settings' "What Tally has learned" page (decisions 156, 162 and 163): under its SubpageHead, the intro, then one
 * bordered line for each learned text, "Netflix.com → Entertainment", with "From N of your answers" (or "Your rule")
 * and a quiet Forget. A text that isn't vague also has Change: the line opens in place into a form with its category
 * select, "From now on … goes here every time.", Save and Cancel. Empty, it says Nothing yet. The root is #page, the
 * swap target of a Forget, of its Undo's toast and of a Change. `error` is a Forget refused; `change` is the line whose
 * Change is open, with its refusal when Tally refused it.
 */
export function LearnedPage({
	lines,
	error,
	change,
	categories = [],
	id = "page",
	titleId = "page-title",
}: {
	lines: LearnedLine[];
	/** A Forget refused (no text chosen), or a Change refused before any line could take it. */
	error?: string;
	/** The line whose Change is open. `error` is its refusal, shown in the line and with the form open. */
	change?: { cleanedText: string; error?: string };
	/** The active categories a Change can file a line in, with the id of each. */
	categories?: { id: number; name: string }[];
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
					{lines.map((line, index) => {
						const title = `${line.name} → ${line.categoryName}`;

						const changing =
							change?.cleanedText === line.cleanedText ? change : undefined;

						return (
							<li class="flex min-h-16 items-center gap-4 rounded-control border border-rule bg-paper px-4 py-2">
								<CategoryIcon icon={line.icon} color={line.color} />
								<span class="min-w-0 flex-1">
									<span class="block text-lg leading-6 wrap-anywhere">
										{title}
									</span>
									<span class="block leading-6 text-muted">
										{line.rule
											? "Your rule"
											: `From ${line.answers} of your answers`}
									</span>
									{!line.vague && (
										<details class="group mt-1" open={Boolean(changing)}>
											<summary class="inline-flex min-h-11 cursor-pointer list-none items-center px-2 text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
												Change<span class="sr-only"> {title}</span>
											</summary>
											<form
												class="mt-2 flex flex-col gap-3"
												method="post"
												action="/settings/learned/change"
												hx-post="/settings/learned/change"
												hx-disable="findAll button[type=submit]"
												hx-target={`#${id}`}
												hx-select={`#${id}`}
												hx-swap="outerHTML"
											>
												<input
													type="hidden"
													name="text"
													value={line.cleanedText}
												/>
												<p class="text-base leading-6 text-ink">
													{`From now on ${line.name} goes here every time.`}
												</p>
												<div class="flex flex-col gap-2">
													<label
														for={`${id}-category-${index}`}
														class="text-base text-ink"
													>
														Category
													</label>
													<SelectField
														id={`${id}-category-${index}`}
														name="category"
														variant="control"
														class="w-full"
													>
														{categories.map((category) => (
															<option
																value={String(category.id)}
																selected={category.id === line.categoryId}
															>
																{category.name}
															</option>
														))}
													</SelectField>
												</div>
												{changing?.error && (
													<p role="alert" class="text-sm text-over">
														{changing.error}
													</p>
												)}
												<div class="flex flex-wrap items-center gap-3">
													<Button type="submit">Save</Button>
													<a
														href="/settings/learned"
														hx-get="/settings/learned"
														hx-target={`#${id}`}
														hx-select={`#${id}`}
														hx-swap="outerHTML"
														class="inline-flex min-h-11 items-center px-2 text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
													>
														Cancel
													</a>
												</div>
											</form>
										</details>
									)}
								</span>
								<form
									class="shrink-0"
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

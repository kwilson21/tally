import type { Child } from "hono/jsx";
import { Button } from "./button";
import { Icon } from "./icons";
import { type SavedMark, SavedSlot, savedRowClass } from "./saved-tick";
import { TextInput } from "./text-input";

export type HouseholdPerson = { id: number; name: string };

const chevron = (
	<Icon
		name="chevron-right"
		class="size-5 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none"
	/>
);

/**
 * The household's shared list of names (the People page, #606). Everyone is the fixed first choice. `head` is the
 * page's back link and title, drawn first inside the section, so a swap brings them back and focus can land on them.
 */
export function HouseholdPeople({
	people,
	head,
	openId,
	addOpen = false,
	error,
	errorPersonId,
	value = "",
	saved,
	action = "/settings/people",
}: {
	people: HouseholdPerson[];
	head?: Child;
	openId?: number;
	addOpen?: boolean;
	error?: string;
	errorPersonId?: number;
	value?: string;
	/**
	 * The person row a save just changed (P119 A, #71): its chevron gives way to the pencil tick. Only a name's own row
	 * is marked, never Everyone (the first, fixed row) or Add a person.
	 */
	saved?: { id: number; mark: SavedMark };
	action?: string;
}) {
	return (
		<section
			id="household-people"
			aria-labelledby="people-title"
			class="lg:max-w-3xl"
		>
			{head}
			<ul class="mt-3 divide-y divide-rule border-y border-rule">
				{people.map((person, index) => {
					const mark =
						index > 0 && saved?.id === person.id ? saved.mark : undefined;
					return (
						<li>
							<details
								class={`group${mark ? ` ${savedRowClass(mark)}` : ""}`}
								open={person.id === openId}
							>
								<summary class="flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 [&::-webkit-details-marker]:hidden">
									<span class="min-w-0 flex-1 truncate text-lg">
										{person.name}
									</span>
									{index === 0 && (
										<span class="text-sm text-muted">Always available</span>
									)}
									{mark ? (
										<SavedSlot class="shrink-0 text-muted">{chevron}</SavedSlot>
									) : (
										chevron
									)}
								</summary>
								{index > 0 && (
									<form
										method="post"
										action={action}
										hx-post={action}
										hx-target="#household-people"
										hx-select="#household-people"
										hx-swap="outerHTML"
										class="flex flex-col gap-3 pb-4"
									>
										<input type="hidden" name="person_id" value={person.id} />
										<input type="hidden" name="action" value="rename" />
										<TextInput
											id={`person-${person.id}`}
											name="name"
											label="Name"
											value={
												person.id === openId && error ? value : person.name
											}
											autocomplete="off"
											error={person.id === errorPersonId ? error : undefined}
										/>
										<div class="flex flex-wrap items-center gap-3">
											<Button type="submit">Save</Button>
											<Button kind="text" type="submit" name="remove" value="1">
												Remove
											</Button>
										</div>
									</form>
								)}
							</details>
						</li>
					);
				})}
				<li>
					<details
						class="group"
						open={addOpen || Boolean(error && openId === undefined)}
					>
						<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 text-accent [&::-webkit-details-marker]:hidden">
							<Icon name="plus" class="size-5" />
							<span class="flex-1">Add a person</span>
							{chevron}
						</summary>
						<form
							method="post"
							action={action}
							hx-post={action}
							hx-target="#household-people"
							hx-select="#household-people"
							hx-swap="outerHTML"
							class="flex flex-col gap-3 pb-4"
						>
							<input type="hidden" name="action" value="add" />
							<TextInput
								id="person-new"
								name="name"
								label="Name"
								value={value}
								autocomplete="off"
								error={openId === undefined ? error : undefined}
							/>
							<div class="flex flex-wrap items-center gap-3">
								<Button type="submit">Add</Button>
								<Button
									kind="secondary"
									href="/settings/people"
									hx-get="/settings/people?peopleFocus=1"
									hx-target="#household-people"
									hx-select="#household-people"
									hx-swap="outerHTML"
								>
									Cancel
								</Button>
							</div>
						</form>
					</details>
				</li>
			</ul>
		</section>
	);
}

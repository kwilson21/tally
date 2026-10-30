import { OTHER_ZONES, US_ZONES, zoneLabel } from "../settings/time-zones";
import { Button } from "./button";
import { chevron } from "./category-row";
import { FormField } from "./form-field";
import { type SavedMark, SavedSlot, savedRowClass } from "./saved-tick";
import { SelectField } from "./select-field";

/** What the zone decides, and what it never touches (decision 67). */
export const TIME_ZONE_HINT =
	"Decides when a new month starts and when a bill is due. Transactions keep the bank's dates.";

/**
 * The Household group's one row (decision 72, P35 A): "Time zone" with the saved zone's everyday
 * name at the right and a chevron, like a category row. Open, it holds a select, its hint, Save and
 * Cancel, in a form that posts without JavaScript and swaps only its own row (`#${id}-disclosure`)
 * with it, so an unsaved Bank sign-in emails switch or an open Household people edit stays. An error
 * opens it. A save's own reply marks the row (P119 A, #71): its chevron gives way to the pencil tick.
 */
export function TimeZoneRow({
	zone,
	error,
	open = false,
	focus = false,
	saved,
	id = "time-zone",
	action = "/settings/time-zone",
	back = "/settings/household",
	backSwap = "/settings/household?focus=zone",
}: {
	/** The household's saved zone, as its IANA name. */
	zone: string;
	/** Why the posted zone wasn't saved; shown under the select, and the row opens with it. */
	error?: string;
	open?: boolean;
	/** Move focus to the row after a swap: it replaced the Save that had it. */
	focus?: boolean;
	/** The row whose save just answered: its chevron gives way to the pencil tick (P119 A, #71). */
	saved?: SavedMark;
	/** The select's id, which its label, hint and error build on. */
	id?: string;
	action?: string;
	/** Cancel's address, and the one htmx fetches so focus returns to the row. */
	back?: string;
	backSwap?: string;
}) {
	const option = ([value, label]: readonly [string, string]) => (
		<option value={value} selected={value === zone}>
			{label}
		</option>
	);
	return (
		<details
			id={`${id}-disclosure`}
			class={`group border-b border-rule${saved ? ` ${savedRowClass(saved)}` : ""}`}
			open={open || Boolean(error)}
		>
			<summary
				class="flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 [&::-webkit-details-marker]:hidden"
				autofocus={focus && !error}
			>
				<span class="min-w-0 truncate text-lg font-medium">Time zone</span>
				<span class="ml-auto shrink-0">{zoneLabel(zone)}</span>
				{saved ? (
					<SavedSlot class="shrink-0 text-muted">{chevron}</SavedSlot>
				) : (
					chevron
				)}
			</summary>
			<form
				method="post"
				action={action}
				class="flex flex-col gap-4 pb-5"
				hx-post={action}
				hx-disable="findAll button[type=submit]"
				hx-indicator={`#${id}-save`}
				hx-target={`#${id}-disclosure`}
				hx-select={`#${id}-disclosure`}
				hx-swap="outerHTML"
			>
				{/* The summary above already says "Time zone", so the label is for screen readers. */}
				<FormField
					id={id}
					label="Time zone"
					hideLabel
					hint={TIME_ZONE_HINT}
					error={error}
				>
					{({ class: errorClass, ...a11y }) => (
						<SelectField
							id={id}
							name="time_zone"
							variant="control"
							class={errorClass}
							autofocus={Boolean(error)}
							{...a11y}
						>
							{US_ZONES.map(option)}
							<optgroup label="Other time zones">
								{OTHER_ZONES.map(option)}
							</optgroup>
						</SelectField>
					)}
				</FormField>
				<div class="flex flex-wrap items-center gap-3">
					<Button id={`${id}-save`} type="submit" busyLabel="Saving…">
						Save
					</Button>
					<Button
						href={back}
						kind="secondary"
						// Back to the group with focus on the row, so the closing is announced.
						hx-get={backSwap}
						hx-target={`#${id}-disclosure`}
						hx-select={`#${id}-disclosure`}
						hx-swap="outerHTML"
					>
						Cancel
					</Button>
				</div>
			</form>
		</details>
	);
}

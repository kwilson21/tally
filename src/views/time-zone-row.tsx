import { OTHER_ZONES, US_ZONES, zoneLabel } from "../settings/time-zones";
import { Button } from "./button";
import { FormField } from "./form-field";
import { Icon } from "./icons";

/** What the zone decides, and what it never touches (decision 67). */
export const TIME_ZONE_HINT =
	"Decides when a new month starts and when a bill is due. Transactions keep the bank's dates.";

/**
 * The Household group's one row (decision 72, P35 A): "Time zone" with the saved zone's everyday
 * name at the right and a chevron, like a category row. Open, it holds a select, its hint, Save and
 * Cancel, in a form that posts without JavaScript and swaps `#household` with it. An error opens it.
 */
export function TimeZoneRow({
	zone,
	error,
	open = false,
	focus = false,
	id = "time-zone",
	action = "/settings/time-zone",
	back = "/settings#household",
	backSwap = "/settings?focus=zone",
}: {
	/** The household's saved zone, as its IANA name. */
	zone: string;
	/** Why the posted zone wasn't saved; shown under the select, and the row opens with it. */
	error?: string;
	open?: boolean;
	/** Move focus to the row after a swap: it replaced the Save that had it. */
	focus?: boolean;
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
		<details class="group border-b border-rule" open={open || Boolean(error)}>
			<summary
				class="flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 [&::-webkit-details-marker]:hidden"
				autofocus={focus && !error}
			>
				<span class="min-w-0 truncate text-lg font-medium">Time zone</span>
				<span class="ml-auto shrink-0">{zoneLabel(zone)}</span>
				<span class="shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none">
					<Icon name="chevron-right" class="size-5" />
				</span>
			</summary>
			<form
				method="post"
				action={action}
				class="flex flex-col gap-4 pb-5"
				hx-post={action}
				hx-disable="findAll button[type=submit]"
				hx-indicator={`#${id}-save`}
				hx-target="#household"
				hx-select="#household"
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
						<select
							id={id}
							name="time_zone"
							class={`min-h-11 rounded-control border border-rule bg-paper px-3 text-lg ${errorClass ?? ""}`}
							autofocus={Boolean(error)}
							{...a11y}
						>
							{US_ZONES.map(option)}
							<optgroup label="Other time zones">
								{OTHER_ZONES.map(option)}
							</optgroup>
						</select>
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
						hx-target="#household"
						hx-select="#household"
						hx-swap="outerHTML"
					>
						Cancel
					</Button>
				</div>
			</form>
		</details>
	);
}

import { ordinal } from "../dates";
import { SelectField } from "./select-field";

export type DueFrequency =
	| "weekly"
	| "biweekly"
	| "monthly"
	| "quarterly"
	| "yearly";

const WEEKDAYS = [
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
	"Sunday",
];
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1);
const FREQUENCIES: [DueFrequency, string][] = [
	["weekly", "every week"],
	["biweekly", "every two weeks"],
	["monthly", "every month"],
	["quarterly", "every quarter"],
	["yearly", "every year"],
];

// The date input is a native control on a ledger line: at least 44px, text-lg (the sentence's size).
const PICKER = "min-h-11 border-b border-muted bg-transparent px-1 text-lg";

type Props = {
	frequency: DueFrequency;
	/** The day: 1 to 31 for a monthly, quarterly or yearly bill; 1 (Monday) to 7 (Sunday) for a weekly one (spec §5). */
	dueDay: number;
	/** The one date an every-two-weeks bill counts from (YYYY-MM-DD). */
	anchorDate?: string;
	/** 1 to 12, for a quarterly bill's first month or a yearly bill's month. */
	anchorMonth?: number;
	error?: string;
};

/**
 * "Due on the 1st every month" as one sentence of native pickers, so there's nothing to type or
 * parse. The form carries every frequency's pickers and CSS shows only the chosen frequency's, keyed
 * off the frequency select (app.css, next to `.bill-month`), so choosing a frequency needs no script.
 * The field names are the ones Add a bill posts today (bills.tsx): a weekly bill's weekday posts as
 * `weekly_day`, and the handler reads it for a weekly bill only. The legend is for screen readers:
 * the visible words already say it.
 */
export function DueRow({
	frequency,
	dueDay,
	anchorDate,
	anchorMonth = 1,
	error,
}: Props) {
	return (
		<fieldset class="due-row flex flex-col gap-2">
			<legend class="sr-only">When it's due</legend>
			<div class="flex flex-wrap items-center gap-x-2 text-lg">
				<span class="due-lead-on">Due on</span>
				<span class="due-lead-the">Due on the</span>
				<SelectField
					name="weekly_day"
					aria-label="Day of the week"
					variant="ledger"
					wrapClass="due-weekly"
				>
					{WEEKDAYS.map((day, i) => (
						<option value={i + 1} selected={i + 1 === dueDay}>
							{day}s
						</option>
					))}
				</SelectField>
				<input
					type="date"
					name="anchor_date"
					value={anchorDate ?? ""}
					aria-label="One date it's due"
					class={`due-biweekly ${PICKER}`}
				/>
				<SelectField
					name="due_day"
					aria-label="Day of the month"
					variant="ledger"
					wrapClass="due-day"
				>
					{DAYS.map((day) => (
						<option value={day} selected={day === dueDay}>
							{ordinal(day)}
						</option>
					))}
				</SelectField>
				<SelectField name="frequency" aria-label="How often" variant="ledger">
					{FREQUENCIES.map(([value, label]) => (
						<option value={value} selected={value === frequency}>
							{label}
						</option>
					))}
				</SelectField>
			</div>
			<div class="due-month flex flex-wrap items-center gap-x-2 text-lg">
				<span class="due-quarter-word">starting in</span>
				<span class="due-year-word">in</span>
				<SelectField name="anchor_month" aria-label="Month" variant="ledger">
					{MONTHS.map((month, i) => (
						<option value={i + 1} selected={i + 1 === anchorMonth}>
							{month}
						</option>
					))}
				</SelectField>
			</div>
			{error && (
				<p role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
		</fieldset>
	);
}

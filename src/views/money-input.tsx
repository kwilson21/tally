// The money input (#66), after the original app's currency input: a dollar field with nudges of a
// cent or a dollar, a round-up chip, and a chip for last month's amount. public/js/money.js runs the
// buttons; the server draws their starting state, and without the script they stay hidden.
import { formatCents, toCents } from "../money";
import { FormField } from "./form-field";

type Props = {
	id: string;
	name: string;
	label: string;
	/** The field's text: what was saved, or what was typed. */
	value: string;
	error?: string;
	/** Last month's amount in cents, offered as a chip when it's above $0. */
	lastMonthCents?: number;
	autofocus?: boolean;
};

const NUDGES: [delta: number, text: string, label: string][] = [
	[-100, "−$1", "Take away $1"],
	[-1, "−1¢", "Take away 1 cent"],
	[1, "+1¢", "Add 1 cent"],
	[100, "+$1", "Add $1"],
];

const button =
	"inline-flex min-h-11 items-center justify-center rounded-control border border-ink text-ink tabular-nums disabled:border-rule disabled:text-muted";
const chip =
	"inline-flex min-h-11 items-center rounded-full border border-rule px-4 text-ink tabular-nums aria-pressed:text-muted";

/** The typed text in cents, or null when it isn't a dollar amount. */
function centsOf(text: string): number | null {
	if (text.trim() === "") return 0;
	try {
		return toCents(text);
	} catch {
		return null;
	}
}

export function MoneyInput({
	id,
	name,
	label,
	value,
	error,
	lastMonthCents = 0,
	autofocus,
}: Props) {
	const cents = centsOf(value);
	const hasCents = cents !== null && cents % 100 !== 0;
	const roundUp = hasCents
		? formatCents(Math.ceil(cents / 100) * 100, { wholeDollars: true })
		: "";
	return (
		<div data-money class="flex flex-col gap-3">
			<FormField id={id} label={label} error={error}>
				{(a11y) => (
					<div class="flex items-center gap-2">
						<span aria-hidden="true" class="text-lg text-muted">
							$
						</span>
						<input
							id={id}
							name={name}
							value={value}
							inputmode="decimal"
							autocomplete="off"
							data-money-input
							autofocus={autofocus}
							class="min-h-11 min-w-0 flex-1 rounded-control border border-rule bg-paper px-3 text-lg tabular-nums"
							{...a11y}
						/>
					</div>
				)}
			</FormField>
			<div data-money-js class="grid grid-cols-4 gap-2">
				{NUDGES.map(([delta, text, aria]) => (
					<button
						type="button"
						data-nudge={String(delta)}
						aria-label={aria}
						disabled={delta < 0 && (cents === null || cents === 0)}
						class={button}
					>
						{text}
					</button>
				))}
			</div>
			<div data-money-js class="flex flex-wrap gap-2">
				<button type="button" data-roundup hidden={!hasCents} class={chip}>
					Round up to {roundUp}
				</button>
				{lastMonthCents > 0 && (
					<button
						type="button"
						data-set={String(lastMonthCents)}
						aria-pressed={String(cents === lastMonthCents)}
						class={chip}
					>
						Last month: {formatCents(lastMonthCents)}
					</button>
				)}
			</div>
		</div>
	);
}

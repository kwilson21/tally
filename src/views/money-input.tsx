// The money input (#66): the owner's hero amount from the original app, in Tally's tokens. A round
// −$1 button, a big amount field with ▲▼ cent arrows inside its right edge, and a round +$1 button;
// under it the Round-to and Last-month chips. public/js/money.js runs the buttons; the server draws
// their starting state, and without the script they stay hidden and the field works on its own.
import { formatCents, toCents } from "../money";
import { Icon } from "./icons";

type Props = {
	id: string;
	name: string;
	label: string;
	/** The field's text: what was saved ("700.00"), or what was typed. */
	value: string;
	error?: string;
	/** Last month's amount in cents, offered as a chip when it's above $0. */
	lastMonthCents?: number;
	/** Average spending in the last three finished months, offered above $0. */
	averageCents?: number | null;
	autofocus?: boolean;
	inputAttributes?: Record<string, string>;
};

/**
 * The typed text in cents, or null when it isn't a dollar amount this box can read. A text starting with
 * "-" is unreadable, as money.js reads it (its DOLLARS has no minus), so the steps and Round to agree.
 */
function centsOf(text: string): number | null {
	const trimmed = text.trim();
	if (trimmed === "") return 0;
	if (trimmed.startsWith("-")) return null;
	try {
		return toCents(trimmed);
	} catch {
		return null;
	}
}

const round =
	"flex size-12 shrink-0 items-center justify-center rounded-full border border-rule bg-paper text-xl font-semibold leading-none text-muted select-none hover:text-ink disabled:opacity-40";
const cent =
	"flex w-11 flex-1 items-center justify-center text-muted hover:bg-band hover:text-ink disabled:opacity-40";
/** A chip under the field. Exported so a drawing of a chip the app doesn't have yet can't drift. */
export const moneyChip =
	"group inline-flex min-h-11 items-center gap-1 rounded-full bg-band px-3 text-sm font-medium text-muted hover:text-ink aria-pressed:text-ink";

/** A chip's check: its slot is always in the chip, hidden until the chip is pressed, so a chip never changes width. */
const Check = () => (
	<span class="inline-flex invisible group-aria-pressed:visible">
		<Icon name="check" class="size-4" />
	</span>
);

/** The ▲ and ▼ of the cent arrows. */
const Arrow = ({ up }: { up: boolean }) => (
	<svg
		class="size-3"
		fill="none"
		stroke="currentColor"
		stroke-width="2.5"
		stroke-linecap="round"
		stroke-linejoin="round"
		viewBox="0 0 24 24"
		aria-hidden="true"
	>
		<path d={up ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
	</svg>
);

export function MoneyInput({
	id,
	name,
	label,
	value,
	error,
	lastMonthCents = 0,
	averageCents = null,
	autofocus,
	inputAttributes,
}: Props) {
	const cents = centsOf(value);
	const unreadable = cents === null;
	const atZero = unreadable || cents === 0;
	const hasCents = cents !== null && cents % 100 !== 0;
	const roundedCents = cents === null ? 0 : Math.ceil(cents / 100) * 100;
	return (
		<div data-money class="flex flex-col gap-2">
			<label for={id} class="text-base text-ink">
				{label}
			</label>
			<div class="flex items-center justify-center gap-3">
				<button
					type="button"
					data-money-js
					data-nudge="-100"
					aria-label={`Decrease ${label} by $1`}
					disabled={atZero}
					class={round}
				>
					−
				</button>
				<div
					class={`flex min-h-[90px] w-[292px] min-w-0 items-center gap-1 rounded-control border bg-paper py-3 pl-3 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent ${error ? "border-over" : "border-rule"}`}
				>
					<span
						aria-hidden="true"
						class="shrink-0 text-lg text-muted select-none"
					>
						$
					</span>
					<input
						id={id}
						name={name}
						value={value}
						placeholder="0.00"
						inputmode="decimal"
						autocomplete="off"
						data-money-input
						{...inputAttributes}
						autofocus={autofocus}
						aria-invalid={error ? "true" : undefined}
						aria-describedby={error ? `${id}-error` : undefined}
						class={`-my-3 min-w-0 flex-1 self-stretch bg-transparent text-[1.75rem] font-bold tabular-nums placeholder:font-normal placeholder:text-muted focus-visible:outline-none ${error ? "field-shake" : ""}`}
					/>
					<div
						data-money-js
						class="-my-3 flex flex-col self-stretch border-l border-rule"
					>
						<button
							type="button"
							data-nudge="1"
							aria-label={`Increase ${label} by 1 cent`}
							disabled={unreadable}
							class={`${cent} rounded-tr-control`}
						>
							<Arrow up />
						</button>
						<button
							type="button"
							data-nudge="-1"
							aria-label={`Decrease ${label} by 1 cent`}
							disabled={atZero}
							class={`${cent} rounded-br-control border-t border-rule`}
						>
							<Arrow up={false} />
						</button>
					</div>
				</div>
				<button
					type="button"
					data-money-js
					data-nudge="100"
					aria-label={`Increase ${label} by $1`}
					disabled={unreadable}
					class={round}
				>
					+
				</button>
			</div>
			{error && (
				<p
					id={`${id}-error`}
					role="alert"
					class="text-center text-sm text-over"
				>
					{error}
				</p>
			)}
			<div data-money-js class="flex flex-wrap justify-center gap-2">
				<button
					type="button"
					data-roundup={hasCents ? String(roundedCents) : ""}
					hidden={!hasCents}
					aria-pressed="false"
					class={moneyChip}
				>
					<Check />
					<span data-roundup-label class="tabular-nums">
						Round to{" "}
						{hasCents ? formatCents(roundedCents, { wholeDollars: true }) : ""}
					</span>
				</button>
				{lastMonthCents > 0 && (
					<button
						type="button"
						data-set={String(lastMonthCents)}
						aria-pressed={String(cents === lastMonthCents)}
						class={moneyChip}
					>
						<Check />
						Last month: {formatCents(lastMonthCents)}
					</button>
				)}
				{averageCents !== null && averageCents > 0 && (
					<button
						type="button"
						data-set={String(averageCents)}
						aria-pressed={String(cents === averageCents)}
						class={moneyChip}
					>
						<Check />
						3-month average: {formatCents(averageCents)}
					</button>
				)}
			</div>
		</div>
	);
}

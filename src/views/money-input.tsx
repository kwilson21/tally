// The money input (#66): the owner's hero amount from the original app, in Tally's tokens. A round
// −$1 button, a big amount field with ▲▼ cent arrows inside its right edge, and a round +$1 button;
// under it the Round-to and Last-month chips. public/js/money.js runs the buttons; the server draws
// their starting state, and without the script they stay hidden and the field works on its own.
import { formatCents, toCents } from "../money";

type Props = {
	id: string;
	name: string;
	label: string;
	/** The field's text: what was saved ("700.00"), or what was typed. */
	value: string;
	error?: string;
	/** Last month's amount in cents, offered as a chip when it's above $0. */
	lastMonthCents?: number;
	autofocus?: boolean;
};

/** The typed text in cents, or null when it isn't a dollar amount. */
function centsOf(text: string): number | null {
	if (text.trim() === "") return 0;
	try {
		return toCents(text);
	} catch {
		return null;
	}
}

const round =
	"flex size-12 shrink-0 items-center justify-center rounded-full border border-rule bg-paper text-xl font-semibold leading-none text-muted select-none hover:text-ink disabled:opacity-40";
const cent =
	"flex w-11 flex-1 items-center justify-center text-muted hover:bg-band hover:text-ink disabled:opacity-40";
const chip =
	"inline-flex min-h-11 items-center gap-1 rounded-full bg-band px-3 text-sm font-medium text-muted tabular-nums hover:text-ink aria-pressed:opacity-50";

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
	autofocus,
}: Props) {
	const cents = centsOf(value);
	const atZero = cents === null || cents === 0;
	const hasCents = cents !== null && cents % 100 !== 0;
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
					aria-label="Decrease by $1"
					disabled={atZero}
					class={round}
				>
					−
				</button>
				<div
					class={`flex w-[292px] min-w-0 items-center gap-1 rounded-lg border bg-paper py-3 pl-3 has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent ${error ? "border-over" : "border-rule"}`}
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
						inputmode="decimal"
						autocomplete="off"
						data-money-input
						autofocus={autofocus}
						aria-invalid={error ? "true" : undefined}
						aria-describedby={error ? `${id}-error` : undefined}
						class="min-w-0 flex-1 bg-transparent text-[1.75rem] font-bold tabular-nums focus-visible:outline-none"
					/>
					<div
						data-money-js
						class="-my-3 flex flex-col self-stretch border-l border-rule"
					>
						<button
							type="button"
							data-nudge="1"
							aria-label="Increase by 1 cent"
							class={`${cent} rounded-tr-lg`}
						>
							<Arrow up />
						</button>
						<button
							type="button"
							data-nudge="-1"
							aria-label="Decrease by 1 cent"
							disabled={atZero}
							class={`${cent} rounded-br-lg border-t border-rule`}
						>
							<Arrow up={false} />
						</button>
					</div>
				</div>
				<button
					type="button"
					data-money-js
					data-nudge="100"
					aria-label="Increase by $1"
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
				<button type="button" data-roundup hidden={!hasCents} class={chip}>
					Round to{" "}
					{hasCents
						? formatCents(Math.ceil(cents / 100) * 100, { wholeDollars: true })
						: ""}
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

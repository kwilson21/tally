import type { Child } from "hono/jsx";
import { shortDay } from "../dates";
import { formatCents } from "../money";
import { Button } from "./button";
import { Icon } from "./icons";
import { TextInput } from "./text-input";
import { WhyLink } from "./why-link";

/** One purchase in the card: its name as the card calls it, its amount and its date. */
export type CardRow = {
	id: number;
	name: string;
	amountCents: number;
	date: string;
};

const CARD =
	"flex flex-col gap-3 rounded-control border border-rule bg-paper p-4";

/** Create, or the family's own category with this name: Add to it, or Restore it when archived (decisions 101, 110). */
function createWords(name: string, existing?: string, archived?: boolean) {
	if (!existing) return `Create ${name}`;
	return archived ? `Restore ${existing}` : `Add to ${existing}`;
}

/** The muted line that says Tally made the guess (decision 120). */
function Guess() {
	return (
		<p class="flex items-center gap-1.5 text-sm text-muted">
			<Icon name="sparkles" class="size-4" />
			Tally's guess
		</p>
	);
}

/**
 * The one card for a suggested new category (decision 120, P135 A), drawn the same in Settings and on the Suggestions
 * page. It is the form that answers: `form` holds the surface's own address and swap, `answers` its Create and No
 * buttons, and every row sends a `shown` value and one checkbox named `tickName`. An unticked row keeps its note under it.
 */
export function NewCategoryCard({
	name,
	rows,
	today,
	tickName,
	ticked,
	notes,
	existing,
	archived,
	error,
	titleId,
	focus = false,
	form,
	hidden,
	answers,
}: {
	/** The name Tally suggested, tidied: "Pet Care". */
	name: string;
	rows: CardRow[];
	/** The household's date, so a day in this year reads without its year. */
	today: string;
	/** The checkbox's field name: Settings' create reads `ids`, the Suggestions page's answer reads `ticked`. */
	tickName: "ids" | "ticked";
	/** The ticks a refused answer posted; left out, every row starts ticked. */
	ticked?: number[];
	notes?: Record<number, string>;
	existing?: string;
	archived?: boolean;
	error?: string;
	/** The headline's id, where the screen has one card to name (the Suggestions page's "suggestion-title"). */
	titleId?: string;
	/** Takes focus as the screen's one headline, when the screen's answer is drawn in place. */
	focus?: boolean;
	/** The form's own attributes: its address and how its answer swaps in. */
	form: Record<string, string>;
	/** Hidden fields every answer sends with it, such as the item's `id`. */
	hidden?: Child;
	/** The attributes of the Create and No buttons: the field each sends, and where No goes. */
	answers: { create: Record<string, string>; no: Record<string, string> };
}) {
	return (
		<form {...form} class={CARD}>
			{hidden}
			<Guess />
			<h2
				id={titleId}
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="font-serif text-xl font-semibold tracking-tight outline-none"
			>
				A new category: {name}
			</h2>
			{error && (
				<p role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
			<ul class="divide-y divide-rule border-y border-rule">
				{rows.map((row) => (
					<li class="group/tx">
						<input type="hidden" name="shown" value={String(row.id)} />
						<label class="flex min-h-11 flex-wrap items-center gap-x-3 py-2">
							<input
								type="checkbox"
								name={tickName}
								value={String(row.id)}
								checked={ticked ? ticked.includes(row.id) : true}
								class="size-5 accent-ink"
							/>
							<span class="min-w-0 flex-1 wrap-anywhere">{row.name}</span>
							<span class="tabular-nums">
								{formatCents(Math.abs(row.amountCents))}
							</span>
							<span class="text-muted">{shortDay(row.date, today)}</span>
						</label>
						<div class="hidden pb-2 supports-[selector(:has(*))]:group-has-[input[type=checkbox]:not(:checked)]/tx:block">
							<TextInput
								id={`note-${row.id}`}
								name={`note_${row.id}`}
								label={`A note for ${row.name} (optional)`}
								value={notes?.[row.id] ?? ""}
								maxlength={500}
								placeholder="Only used if you untick it"
								hint="Tally sorts it again right away, with your note."
								surface="paper"
								class="w-full"
							/>
						</div>
					</li>
				))}
			</ul>
			<p class="text-sm text-muted">Untick any that don't belong.</p>
			<div class="flex flex-wrap items-center gap-3">
				<Button {...answers.create}>
					{createWords(name, existing, archived)}
				</Button>
				<Button kind="text" {...answers.no}>
					No
				</Button>
				<WhyLink section="categorization" topic="suggested categories" />
			</div>
		</form>
	);
}

/**
 * Organize's short form of the card, above its chips (decision 120, P135 A): Tally's guess for the merchant on screen,
 * with the suggestion's other merchants counted, then Create (the card's own Create, with every purchase ticked) and a
 * link that moves focus to the chips. It sends the suggestion's id and each purchase the card counts (`shown`), so
 * Create files only those. A refused Create's reason shows under the headline, as NewCategoryCard shows its error.
 */
export function OrganizeNewCategoryCard({
	name,
	existing,
	archived,
	others,
	action,
	suggestionId,
	shown,
	error,
}: {
	name: string;
	existing?: string;
	archived?: boolean;
	/** The suggestion's other merchants, each counted once. */
	others: number;
	/** Where Create posts: Organize's own address for it. */
	action: string;
	suggestionId: number;
	/** The purchases the card counts, each sent as `shown`. */
	shown: number[];
	/** A refused Create's reason, drawn under the headline. */
	error?: string;
}) {
	const more = others === 0 ? "" : ` and ${others} more`;
	return (
		<form
			method="post"
			action={action}
			hx-post={action}
			hx-disable="findAll button[type=submit]"
			hx-target="#organize-page"
			hx-select="#organize-page"
			hx-swap="outerHTML"
			class={CARD}
		>
			<input type="hidden" name="suggestion" value={String(suggestionId)} />
			<Guess />
			<h2 class="text-lg">
				Tally suggested a new category for this{more}: {name}
			</h2>
			{error && (
				<p role="alert" class="text-sm text-over">
					{error}
				</p>
			)}
			{shown.map((id) => (
				<input type="hidden" name="shown" value={String(id)} />
			))}
			<div class="flex flex-wrap items-center gap-3">
				<Button type="submit">{createWords(name, existing, archived)}</Button>
				<Button kind="text" href="#organize-category">
					Pick a category below
				</Button>
			</div>
		</form>
	);
}

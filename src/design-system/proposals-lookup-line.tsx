// P146 (#988, spec §7 "What a person sees"): how the store lookup's line looks on a Maybe guess, and where its
// "Don't use this" sits. When a web search about the store helped the guess, the card says so, under Tally's guess.
// Each option is a hand-assembled copy of the real Maybe card (SuggestionCard's category markup) with only the
// lookup line changed, on the same fake data. Nothing here is wired to data, and nothing is decided until the owner
// picks (decision 47).

import { Button } from "../views/button";
import { CategoryGrid } from "../views/category-grid";
import { Icon } from "../views/icons";
import { LookupLine as AppLookupLine } from "../views/lookup-line";
import { MaybeQuestion } from "../views/suggestion-review";
import { Switch } from "../views/switch";
import { WhyLink } from "../views/why-link";
import { type Option, Options } from "./proposal-parts";
import { CATEGORY_COLORS } from "./tokens";

/** The three treatments of the line, in the order the owner sees them. */
type Treatment = "a" | "b" | "c";

/** A card's content: the fake transaction and what Tally guessed about it. */
type CardContent = {
	store: string;
	bank: string;
	amount: string;
	day: string;
	maybe: string;
	sure: number;
	yes: string;
	/** The line Tally looked up about the store, shown under the guess. */
	line: string;
	/** The position in the queue, shown above the card. */
	position?: string;
};

const LA_COOP: CardContent = {
	store: "La Coop",
	bank: "LA COOP 0423 ARLINGTON VA",
	amount: "$6.75",
	day: "Nov 20",
	maybe: "Eating Out",
	sure: 88,
	yes: "Yes, Eating Out",
	line: "Coffee shop in Arlington, VA",
	position: "Suggestions · 2 of 5",
};

const LONG_LINE_CARD: CardContent = {
	store: "Maple Street Hardware",
	bank: "MAPLE ST HDWE 0098",
	amount: "$41.20",
	day: "Nov 19",
	maybe: "Home",
	sure: 64,
	yes: "Yes, Home",
	line: "Independent hardware store and garden store in Takoma Park, Maryland, since 1946",
	position: "Suggestions · 2 of 5",
};

/** Category chips for the edit panel: the same names and icons the catalog's category grid uses. */
const PANEL_CATEGORIES = [
	{
		id: 1,
		name: "Groceries",
		icon: "groceries",
		color: CATEGORY_COLORS[0] ?? "",
	},
	{
		id: 2,
		name: "Eating Out",
		icon: "eating-out",
		color: CATEGORY_COLORS[1] ?? "",
	},
	{ id: 3, name: "Gas", icon: "gas", color: CATEGORY_COLORS[2] ?? "" },
	{ id: 4, name: "Kids", icon: "kids", color: CATEGORY_COLORS[3] ?? "" },
	{
		id: 5,
		name: "Household",
		icon: "household",
		color: CATEGORY_COLORS[4] ?? "",
	},
	{ id: 6, name: "Car", icon: "car", color: CATEGORY_COLORS[5] ?? "" },
];

/** The action's accessible name names the store, so a screen reader hears which line it removes. */
const dontUse = (store: string) => `Don't use this for ${store}`;

/** The lookup line in one of its three treatments. Its action does nothing here: it's a drawing. */
function LookupLine({
	treatment,
	store,
	line,
}: {
	treatment: Treatment;
	store: string;
	line: string;
}) {
	const aria = dontUse(store);

	if (treatment === "a") {
		return (
			<p class="flex flex-wrap items-center gap-x-2 text-sm text-muted">
				Looked up: {line}
				<Button type="button" kind="text" aria-label={aria}>
					Don't use this
				</Button>
			</p>
		);
	}

	if (treatment === "b") {
		return (
			<AppLookupLine line={line} store={store} button={{ type: "button" }} />
		);
	}

	return (
		<div class="flex flex-col items-start gap-1 rounded-control border border-rule p-3">
			<p class="text-sm text-ink">Tally looked this store up</p>
			<p class="text-sm text-muted">{line}</p>
			<Button type="button" kind="quiet" aria-label={aria}>
				Don't use this
			</Button>
		</div>
	);
}

/** Tally's guess and its Why?, the card's guess line as SuggestionCard draws it (its Guess is not exported). */
function Guess({ sure }: { sure: number }) {
	return (
		<p class="flex flex-wrap items-center gap-x-2 text-sm text-ink">
			<span class="inline-flex items-center gap-1.5">
				<Icon name="sparkles" class="size-4" />
				Tally's guess · {sure}% sure
			</span>
			<WhyLink section="categorization" topic="Tally's guess" />
		</p>
	);
}

/** The Maybe card for a category guess, as the Suggestions page draws it, with the lookup line in its place. */
function MaybeCard({
	card,
	treatment,
}: {
	card: CardContent;
	treatment: Treatment;
}) {
	const lookup = (
		<LookupLine treatment={treatment} store={card.store} line={card.line} />
	);

	return (
		<>
			{card.position && <p class="mt-2 text-muted">{card.position}</p>}
			<div class={card.position ? "mt-6" : undefined}>
				<div class="flex flex-col gap-5">
					<div>
						<p class="font-serif text-3xl font-semibold tracking-tight">
							{card.store}
						</p>
						<p class="mt-1 text-sm text-muted wrap-anywhere">{card.bank}</p>
						<p class="text-muted">
							{card.amount} · {card.day}
						</p>
					</div>
					<MaybeQuestion>Maybe {card.maybe}</MaybeQuestion>
					<Guess sure={card.sure} />
					{lookup}
					<Button type="button" class="w-full">
						{card.yes}
					</Button>
					<details class="group rounded-control border border-rule px-4">
						<summary class="flex min-h-11 cursor-pointer items-center justify-between text-lg">
							Something else
							<Icon
								name="chevron-right"
								class="size-5 transition group-open:rotate-90"
							/>
						</summary>
					</details>
					<p class="text-center">
						<span class="inline-flex min-h-11 items-center text-accent">
							Skip
						</span>
					</p>
				</div>
			</div>
		</>
	);
}

/** The edit panel's category part: the store, Tally's guess, the lookup line, then the category chips. */
function EditPanel({
	treatment,
	name,
}: {
	treatment: Treatment;
	name: string;
}) {
	return (
		<div class="flex flex-col gap-4">
			<div class="flex flex-col gap-1">
				<p class="font-serif text-3xl font-semibold tracking-tight">La Coop</p>
				<p class="text-muted">
					<span class="text-lg font-semibold text-ink">$6.75</span> · Nov 20
				</p>
				<p class="text-sm text-muted">LA COOP 0423 ARLINGTON VA</p>
			</div>
			<fieldset class="flex flex-col gap-2">
				<legend class="text-base text-ink">Category</legend>
				<p class="text-sm text-muted">Tally's guess · 88% sure</p>
				<LookupLine treatment={treatment} store="La Coop" line={LA_COOP.line} />
				<CategoryGrid name={name} categories={PANEL_CATEGORIES} tallyId={2} />
			</fieldset>
		</div>
	);
}

/** The three options for one card at one width, each drawn with its own copy of the card. */
function cardOptions(
	card: CardContent,
	desktop: boolean,
	/** Only the first phone block carries the owner's pick: the proposals test wants one Picked per section. */
	pickB = false,
): Option[] {
	const frame = desktop ? { desktop: true } : {};

	return [
		{
			name: "Looked up, action beside",
			note: "One muted line; the action sits at its end and wraps under it on a phone.",
			tradeoff:
				"Shortest. On a phone the action can wrap to its own row anyway.",
			screen: <MaybeCard card={card} treatment="a" />,
			...frame,
		},
		{
			name: "From the web, action under",
			note: "The line has its own row with a small search icon; the action is a quiet link on the row below.",
			tradeoff: 'Clear what "this" means; one more row of height.',
			screen: <MaybeCard card={card} treatment="b" />,
			recommended: pickB
				? "The owner's pick: the line and its action each get a row, so “Don't use this” is clear about what it removes."
				: undefined,
			picked: pickB,
			...frame,
		},
		{
			name: "A note of its own",
			note: "A small bordered note between the guess and the button; the most visible of the three.",
			tradeoff: "Hard to miss; adds a box to a card that has none.",
			screen: <MaybeCard card={card} treatment="c" />,
			...frame,
		},
	];
}

/** The three options for the edit panel, at phone width. */
const editOptions = (): Option[] => [
	{
		name: "Looked up, action beside",
		note: "The edit panel's category part, with the line as one muted line.",
		tradeoff: "Shortest. On a phone the action can wrap to its own row anyway.",
		screen: <EditPanel treatment="a" name="p146-edit-a" />,
	},
	{
		name: "From the web, action under",
		note: "The edit panel's category part, with the line on its own row and the action under it.",
		tradeoff: 'Clear what "this" means; one more row of height.',
		screen: <EditPanel treatment="b" name="p146-edit-b" />,
	},
	{
		name: "A note of its own",
		note: "The edit panel's category part, with the line in a small bordered note.",
		tradeoff: "Hard to miss; adds a box to a card that has none.",
		screen: <EditPanel treatment="c" name="p146-edit-c" />,
	},
];

/** The Settings switch, drawn as the app's own Switch: on, and greyed out with what it needs. */
function SettingsSwitches() {
	return (
		<div class="flex max-w-prose flex-col">
			<Switch
				id="p146-switch-on"
				name="p146-lookup-on"
				label="Look up new stores on the web"
				hint="Searches the web once for a store, to help guess its category and name. Only the store's name as your bank gives it is sent, with numbers taken out."
				checked
			/>
			<Switch
				id="p146-switch-off"
				name="p146-lookup-off"
				label="Look up new stores on the web"
				hint="Searches the web once for a store, to help guess its category and name. Only the store's name as your bank gives it is sent, with numbers taken out."
				disabled
				note="Needs Categories and exclusions and Income on."
			/>
		</div>
	);
}

/** P146: the lookup line's three treatments on the card, in the edit panel, and the Settings switch beside them. */
export function LookupLineProposal() {
	return (
		<div class="mt-6 flex flex-col gap-10">
			<div class="flex flex-col gap-4">
				<h3 class="font-serif text-2xl font-semibold">On the review card</h3>
				<Options options={cardOptions(LA_COOP, false, true)} />
				<p class="font-semibold">At 1280</p>
				<Options options={cardOptions(LA_COOP, true)} />
			</div>
			<div class="flex flex-col gap-4">
				<h3 class="font-serif text-2xl font-semibold">
					With the longest line (80 characters), on a phone
				</h3>
				<Options options={cardOptions(LONG_LINE_CARD, false)} />
			</div>
			<div class="flex flex-col gap-4">
				<h3 class="font-serif text-2xl font-semibold">In the edit panel</h3>
				<Options options={editOptions()} />
			</div>
			<div class="flex flex-col gap-4">
				<h3 class="font-serif text-2xl font-semibold">
					Not part of the pick: the Settings switch
				</h3>
				<p class="max-w-prose text-sm text-muted">
					The switch is the app's own Switch, and its words are as drafted here.
					It is not part of the three treatments above.
				</p>
				<SettingsSwitches />
			</div>
		</div>
	);
}

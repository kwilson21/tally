import { monthName } from "../dates";
import { formatCents } from "../money";
import { zoneLabel } from "../settings/time-zones";
import { Band } from "./band";
import { ContentsList, type Place } from "./contents-list";
import { Icon } from "./icons";

/**
 * A Settings page's back link to Settings and its h1, drawn first in the page's section, so the link comes first
 * in reading order and a swap of the section brings it back too (P134 A, #606). `focus` moves focus to the title.
 */
export function SubpageHead({
	title,
	titleId,
	focus = false,
}: {
	title: string;
	/** The h1's id, which the section's aria-labelledby names. */
	titleId: string;
	focus?: boolean;
}) {
	return (
		<>
			<a
				href="/settings"
				class="flex min-h-11 items-center gap-1 text-lg text-ink no-underline"
			>
				<Icon name="chevron" class="size-5 rotate-180" />
				Settings
			</a>
			<h1
				id={titleId}
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="mt-2 font-serif text-4xl font-semibold tracking-tight"
			>
				{title}
			</h1>
		</>
	);
}

/** The live counts the contents rows show, each read from data the route already has (P134 A, #606). */
export type ContentsCounts = {
	/** Active categories this month, and their budgets' total in cents (null when none has a budget). */
	categories: { count: number; budgetCents: number | null };
	/** Tally's rules: the merchants with an Always rule. */
	merchants: number;
	/** The household's time zone, as its IANA name. */
	zone: string;
	bankEmailsOn: boolean;
	/** The people in the household besides Everyone. */
	people: number;
	/** How many of the AI switches are off. */
	aiOff: number;
	/** Transactions the AI sorted this month, and that month (YYYY-MM). */
	sorted: number;
	month: string;
};

/** The one-line folio each Settings row shows at its right, its words and its count (P134 A, #606). */
export function settingsPlaces(counts: ContentsCounts): Place[] {
	const { categories, merchants, people } = counts;
	const budget =
		categories.budgetCents === null
			? ""
			: ` · ${formatCents(categories.budgetCents, { wholeDollars: categories.budgetCents % 100 === 0 })} a month`;
	const ai = `${counts.aiOff === 0 ? "All on" : `${counts.aiOff} off`} · ${counts.sorted} sorted in ${monthName(counts.month)}`;
	return [
		{
			name: "Categories",
			href: "/settings/categories",
			icon: "tag",
			desc: "What you track, and each budget",
			folio: {
				text: `${categories.count} ${categories.count === 1 ? "category" : "categories"}${budget}`,
				tone: "muted",
			},
		},
		{
			name: "Tally's rules",
			href: "/settings/rules",
			icon: "check",
			desc: "Always and never, for merchants",
			folio: {
				text: `${merchants} ${merchants === 1 ? "merchant" : "merchants"}`,
				tone: "muted",
			},
		},
		{
			name: "Household",
			href: "/settings/household",
			icon: "household",
			desc: "Time zone and bank sign-in emails",
			folio: {
				text: `${zoneLabel(counts.zone)} · sign-in emails ${counts.bankEmailsOn ? "on" : "off"}`,
				tone: "muted",
			},
		},
		{
			name: "People",
			href: "/settings/people",
			icon: "kids",
			desc: "Who's in the household",
			folio: {
				text:
					people === 0
						? "Everyone"
						: `${people} ${people === 1 ? "person" : "people"}`,
				tone: "muted",
			},
		},
		{
			name: "AI suggestions",
			href: "/settings/ai",
			icon: "sparkles",
			desc: "The five switches, and what Tally sorted",
			folio: { text: ai, tone: "muted" },
		},
		{
			name: "Your data",
			href: "/settings/data",
			icon: "documents",
			desc: "Download everything Tally stores",
			folio: { text: "Download", tone: "muted" },
		},
	];
}

/**
 * Settings' contents page (P134 A, #606): its title, the suggestions Band above, then one row for each section,
 * drawn like More's list. The Band shows only while suggestions wait.
 */
export function SettingsContents({
	waiting,
	places,
}: {
	waiting: number;
	places: Place[];
}) {
	return (
		<>
			<h1 class="font-serif text-4xl font-semibold tracking-tight">Settings</h1>
			{waiting > 0 && (
				<div class="mt-4 lg:max-w-3xl">
					<Band
						href="/settings/suggestions"
						detail="Tally's guesses; you decide"
					>
						{waiting} {waiting === 1 ? "suggestion" : "suggestions"} to check
					</Band>
				</div>
			)}
			<div class="lg:max-w-3xl">
				<ContentsList places={places} />
			</div>
		</>
	);
}

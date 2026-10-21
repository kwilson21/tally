import type { Child } from "hono/jsx";
import type { AppleCardAccount, Bank } from "../db/accounts";
import { flaggedBanks } from "../stale-bank";
import { TallyMark } from "./brand";
import { Icon, type IconName, ROW_OPENS } from "./icons";
import { type NavKey, SIDEBAR_ITEMS } from "./nav";

/** A place's live count, at the right of its name: muted, in ink, or the brick alert that asks for attention. */
export type Folio = { text: string; tone: "muted" | "ink" | "attention" };

/** One place More holds: a row that opens a page, with what it holds and a count when it has one (P122 A). */
export type Place = {
	name: string;
	href: string;
	/** The sidebar's icon. How Tally works has none and draws the tally mark instead. */
	icon?: IconName;
	mark?: boolean;
	folio?: Folio;
	/** What the place holds, in one muted line. */
	desc: string;
};

/** The sidebar's own item for a place, so its name, link and icon can't drift from the sidebar's. */
function sidebarPlace(key: NavKey, desc: string, folio?: Folio): Place {
	const item = SIDEBAR_ITEMS.find((entry) => entry.key === key);
	if (!item) throw new Error(`No sidebar item for ${key}`);
	return { name: item.label, href: item.href, icon: item.icon, desc, folio };
}

/**
 * Accounts' folio: Needs attention when a bank needs signing in (the rule Home's BankBehind uses), else None
 * linked yet before any bank is linked (Accounts' own empty state), else the count of the accounts of the
 * banks that aren't disconnected, which Accounts lists too.
 */
function accountsFolio(
	banks: Bank[],
	today: string,
	appleCard: AppleCardAccount | null,
): Folio {
	if (flaggedBanks(banks, today).some((bank) => bank.reason === "sign-in"))
		return { text: "Needs attention", tone: "attention" };
	// The Apple Card counts from its first upload, balance or not, until it is removed (spec §8.10).
	const card = appleCard && appleCard.removedAt === null ? 1 : 0;
	if (banks.length === 0 && card === 0)
		return { text: "None linked yet", tone: "muted" };
	const count =
		banks
			.filter((bank) => !bank.disconnected)
			.reduce((total, bank) => total + bank.accounts.length, 0) + card;
	return {
		text: count === 1 ? "1 account" : `${count} accounts`,
		tone: "muted",
	};
}

/**
 * More's places in the order the page lists them, each with its live count. Settings' count is `toCheck`,
 * the length of the same queue its Band counts, so the two can't drift.
 */
export function contentsPlaces({
	demo,
	banks,
	today,
	toCheck,
	appleCard,
}: {
	demo: boolean;
	/** The banks Accounts lists, each with its accounts. */
	banks: Bank[];
	/** The household's today, which the stale-bank rule reads. */
	today: string;
	/** The suggestions waiting for a person, as Settings' Band counts them. */
	toCheck: number;
	/** The household's Apple Card account, or null before its first upload (More counts it from then, spec §8.10). */
	appleCard?: AppleCardAccount | null;
}): Place[] {
	return [
		sidebarPlace(
			"accounts",
			"Balances, net worth and your banks",
			accountsFolio(banks, today, appleCard ?? null),
		),
		sidebarPlace(
			"settings",
			"Categories, rules, your household and your data",
			toCheck > 0 ? { text: `${toCheck} to check`, tone: "ink" } : undefined,
		),
		{
			name: "How Tally works",
			href: "/how-it-works",
			mark: true,
			desc: demo
				? "What each number means, with the Riveras' numbers"
				: "What each number means, with your numbers",
		},
	];
}

/** A folio's words. The alert is brick, as Needs attention is everywhere it shows (P122 A). */
function FolioWords({ folio }: { folio: Folio }) {
	if (folio.tone === "attention")
		return (
			<span class="inline-flex shrink-0 items-center gap-1 text-sm text-over">
				<Icon name="alert" class="size-4" />
				{folio.text}
			</span>
		);
	return (
		<span
			class={`text-right text-sm ${folio.tone === "ink" ? "text-ink" : "text-muted"}`}
		>
			{folio.text}
		</span>
	);
}

/**
 * More's contents list (P122 A): a ruled list of places. Each is a link with the sidebar's icon (or the
 * tally mark), its name, a dotted leader and its folio when it has one, and a muted line on what it holds.
 * The leader is hidden from screen readers, so each link's name reads in order: "Accounts, 3 accounts,
 * Balances, net worth and your banks". When the leader and folio don't fit beside the name, they drop together
 * to a line of their own under it, the folio at the right edge, so a count is never cut short or squeezed.
 */
export function ContentsList({
	places,
	children,
}: {
	places: Place[];
	/** Rows after the places, such as the keys' row below lg (decision 118). */
	children?: Child;
}) {
	return (
		<ul class="mt-6 divide-y divide-rule border-y border-rule">
			{places.map((place) => (
				<li>
					<a
						href={place.href}
						aria-label={[place.name, place.folio?.text, place.desc]
							.filter(Boolean)
							.join(", ")}
						class={`grid min-h-16 grid-cols-[1.5rem_1fr] items-start gap-x-4 py-3 text-ink no-underline ${ROW_OPENS}`}
					>
						{place.mark ? (
							<TallyMark class="mt-0.5 size-6" />
						) : (
							place.icon && <Icon name={place.icon} class="mt-0.5 size-6" />
						)}
						<span class="min-w-0">
							<span class="flex flex-wrap items-baseline gap-x-2">
								<span class="shrink-0 text-lg">{place.name}</span>
								{place.folio && (
									<span class="flex min-w-0 flex-auto items-baseline gap-2">
										<span
											aria-hidden="true"
											class="min-w-4 flex-1 border-b-2 border-dotted border-rule"
										/>
										<FolioWords folio={place.folio} />
									</span>
								)}
							</span>
							<span class="block text-sm text-muted">{place.desc}</span>
						</span>
					</a>
				</li>
			))}
			{children}
		</ul>
	);
}

/**
 * The small colophon that closes More (P122 A): the tally mark, then "Tally demo · resets every night" in
 * the demo, or the deploy's release and commit in the family's app. APP_VERSION is written with a space
 * between them ("v2026.10.12 9e5e14d"), shown with a middle dot. Nothing is drawn when no version is set.
 */
export function Colophon({
	demo,
	version,
}: {
	demo: boolean;
	version?: string;
}) {
	const release = version?.trim().split(/\s+/).join(" · ");
	const words = demo
		? "Tally demo · resets every night"
		: release && `Tally ${release}`;
	if (!words) return null;
	return (
		<p class="mt-10 flex items-center justify-center gap-2 text-sm text-muted">
			<TallyMark class="size-4" />
			{words}
		</p>
	);
}

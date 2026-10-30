// P143 (#780): net worth on the day a new account starts, drawn for the owner's pick. The owner picked A (decision 154):
// the line keeps its past months, each account counts from its first balance, and the sentence under the number names an
// account added since the line's start and the day. Today, A, B and C are drawn; the real AccountsTop and NetWorthChart
// show made-up balances, inert and labelled, like the rest of the page.

import { formatCents } from "../money";
import {
	type AccountAdded,
	type NetWorthPoint,
	type NetWorthView,
	netWorthView,
} from "../net-worth";
import { AccountsTop } from "../views/accounts-top";
import { WhyLink } from "../views/why-link";
import { Choice, Choices, Phone, Shot } from "./proposals-polish-4";
import { Specimen } from "./specimen";

const TODAY = "2026-10-30";
const ADDED = "2026-10-18";

/** Each day from `from` to `to`, YYYY-MM-DD. */
function days(from: string, to: string): string[] {
	const out: string[] = [];
	const day = new Date(`${from}T00:00:00Z`);
	const end = new Date(`${to}T00:00:00Z`);
	while (day <= end) {
		out.push(day.toISOString().slice(0, 10));
		day.setUTCDate(day.getUTCDate() + 1);
	}
	return out;
}

/**
 * A made-up six months of net worth: $38,360 on May 1, rising with each payday and dipping with the bills, to $42,000 by
 * Oct 17; from ADDED on, `step` cents more (negative for a card's balance owed), then rising again to today.
 */
function series(step: number): NetWorthPoint[] {
	const all = days("2026-05-01", TODAY);
	const before = all.filter((d) => d < ADDED);
	return all.map((date, i) => {
		const n = Math.min(i, before.length - 1);
		// A payday on the 1st and the 15th lifts it, and the days' spending takes some back: a small sawtooth on a steady rise.
		const trend = 3_836_000 + Math.round((n / (before.length - 1)) * 364_000);
		const day = Number(date.slice(8, 10));
		const sincePayday = day < 15 ? day - 1 : day - 15;
		const wobble = 15_000 - sincePayday * 1_000;
		const after = date >= ADDED ? step + (i - before.length) * 1_000 : 0;
		return { date, cents: trend + wobble + after };
	});
}

const CARD = series(-124_000);
const BANK = series(634_000);

const last = (points: NetWorthPoint[]) => points.at(-1)?.cents ?? 0;

/** The view the chart draws: with `added`, its sentence names the accounts added since the line's start (decision 154). */
function view(
	points: NetWorthPoint[],
	added: AccountAdded[] = [],
): NetWorthView {
	return netWorthView(points, TODAY, added);
}

/** B's view: the same line, with the sentence B writes in place of the change alone. */
function withSentence(points: NetWorthPoint[], sentence: string): NetWorthView {
	const drawn = view(points);
	return drawn.kind === "line" ? { ...drawn, sentence } : drawn;
}

const CARD_ADDED: AccountAdded[] = [
	{ name: "Apple Card", verb: "added", date: ADDED },
];
const BANK_LINKED: AccountAdded[] = [
	{ name: "Wells Fargo", verb: "linked", date: ADDED },
];

const whole = (cents: number) => formatCents(cents, { wholeDollars: true });

/** A round cap on a zero-length stroke: a dot that stays round however the chart's box stretches. */
function Cap({ at, width, tone }: { at: string; width: number; tone: string }) {
	const [x, y] = at.split(",");
	return (
		<path
			d={`M${x} ${y}h0.01`}
			stroke-width={width}
			stroke-linecap="round"
			vector-effect="non-scaling-stroke"
			class={tone}
		/>
	);
}

/**
 * C only: Accounts' top with AccountsTop's and NetWorthChart's markup, plus an open ring on the line where Apple Card
 * started and a key under the dates. The real chart has no mark, so this draws its own copy.
 */
function MarkedTop({ points }: { points: NetWorthPoint[] }) {
	const drawn = view(points);
	if (drawn.kind !== "line") return null;
	const index = points.findIndex((p) => p.date === ADDED);
	const ring = drawn.points.split(" ")[index] ?? "0,0";
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">Accounts</h1>
			<p class="mt-3 text-lg text-muted">Net worth</p>
			<p class="font-serif text-6xl font-semibold tabular-nums tracking-tight">
				{whole(last(points))}
			</p>
			<p class="mt-1 flex flex-wrap items-center gap-x-2">
				<span class="font-serif text-lg italic">{drawn.sentence}</span>
				<span class="inline-flex items-center gap-x-2 whitespace-nowrap">
					<span aria-hidden="true">·</span>
					<WhyLink section="net-worth" topic="net worth" />
				</span>
			</p>
			<svg
				viewBox="0 0 100 100"
				preserveAspectRatio="none"
				aria-hidden="true"
				fill="none"
				class="mt-4 h-28 w-full overflow-visible"
			>
				{[6, 35.3, 64.7, 94].map((rule) => (
					<line
						x1="0"
						x2="100"
						y1={rule}
						y2={rule}
						stroke-width="1"
						vector-effect="non-scaling-stroke"
						class="stroke-rule"
					/>
				))}
				<polyline
					points={drawn.points}
					stroke-width="2"
					stroke-linejoin="round"
					stroke-linecap="round"
					vector-effect="non-scaling-stroke"
					class="stroke-ink"
				/>
				{/* The ring is an ink cap with a smaller paper cap inside it. */}
				<Cap at={ring} width={12} tone="stroke-ink" />
				<Cap at={ring} width={7} tone="stroke-paper" />
				<Cap at={`${drawn.end.x},${drawn.end.y}`} width={8} tone="stroke-ink" />
			</svg>
			<p
				aria-hidden="true"
				class="mt-1 flex justify-between text-sm tabular-nums text-muted"
			>
				<span>{drawn.startLabel}</span>
				<span>{drawn.endLabel}</span>
			</p>
			<p class="mt-2 flex items-center gap-2 text-sm text-muted">
				<span
					aria-hidden="true"
					class="inline-block size-3 rounded-full border-2 border-ink"
				/>
				You added Apple Card on Oct 18.
			</p>
		</>
	);
}

function Accounts({
	label,
	points,
	history,
}: {
	label: string;
	points: NetWorthPoint[];
	/** The real chart's view; none draws C's marked copy. */
	history?: NetWorthView;
}) {
	return (
		<Phone label={label} demo={false}>
			{history ? (
				<AccountsTop netWorthCents={last(points)} history={history} />
			) : (
				<MarkedTop points={points} />
			)}
		</Phone>
	);
}

/** The rule How Tally works would say, under Net worth's rules, for an option. */
function Rule({ children }: { children: string }) {
	return (
		<div class="max-w-[392px] rounded-control border border-rule p-4 text-sm">
			<p class="font-medium">
				How Tally works, Net worth · <span class="text-accent">Why?</span>
			</p>
			<p class="mt-2">{children}</p>
		</div>
	);
}

const asBuilt = view(CARD.filter((p) => p.date >= ADDED));
const cardChange = last(CARD) - (CARD[0]?.cents ?? 0);
const bankChange = last(BANK) - (BANK[0]?.cents ?? 0);
const withoutCard = cardChange + 124_000;

export function NetWorthProposal() {
	return (
		<Specimen
			id="p143-net-worth"
			title="P143 · Net worth on the day a new account starts"
			tier="visual"
			sentence="Net worth on the day a new account starts, drawn for the owner's pick (#780): Today, as built, where the line starts again on the day the account gets its first balance; A (recommended), the line keeps its past months and the sentence names the account and the day; B, the new account's first balance left out of the change; and C, a ring on the line with a key under it."
		>
			<p class="max-w-prose">
				You picked keeping the line's past months when a new account starts
				(#780). On that day the line steps: down by what a card owes, or up by a
				new bank's cash. These are the words that say so, so the step isn't read
				as spending. The pictures are Accounts on Oct 30, after Apple Card
				($1,240 owed) was added on Oct 18.
			</p>

			<Choices>
				<Choice
					name="Today, as built"
					note="The line starts again on the day Apple Card got its first balance, so May to October is gone until six months pass."
				>
					<Shot caption="12 days after adding Apple Card">
						<Accounts
							label="Accounts as built: the line starts on Oct 18"
							points={CARD}
							history={asBuilt}
						/>
					</Shot>
				</Choice>

				<Choice
					name="A: name the new account after the change"
					note="The line keeps May to October and steps down on Oct 18. The sentence keeps its change and adds one plain clause: when you added the account. A bank reads “You linked Wells Fargo on Oct 18.”"
					why="The step and its cause are side by side in the one sentence people already read, and the number still matches the headline."
					cost="The change since May still counts the card's $1,240, so it reads lower than your real saving."
					picked
				>
					<Shot caption="Apple Card, owed $1,240">
						<Accounts
							label={`Option A, Apple Card: ${whole(cardChange)} up since May, and the clause`}
							points={CARD}
							history={view(CARD, CARD_ADDED)}
						/>
					</Shot>
					<Shot caption="A new bank with $6,340">
						<Accounts
							label={`Option A, a new bank: ${whole(bankChange)} up since May, and the clause`}
							points={BANK}
							history={view(BANK, BANK_LINKED)}
						/>
					</Shot>
					<Rule>
						The line keeps its past months. An account you add counts from its
						first balance, so on that day the line steps down by what a card
						owes or up by a bank's cash, and the sentence under the number names
						the account and the day.
					</Rule>
				</Choice>

				<Choice
					name="B: leave the new account's first balance out of the change"
					note="Same line. The sentence's change leaves out Apple Card's first balance, so it shows what you saved, and says what it left out."
					cost="The change no longer equals the headline minus May's number, and the line still steps down where the sentence says up."
				>
					<Shot caption="Apple Card, owed $1,240">
						<Accounts
							label={`Option B: ${whole(withoutCard)} up since May, not counting Apple Card`}
							points={CARD}
							history={withSentence(
								CARD,
								`Up ${whole(withoutCard)} since May, not counting Apple Card's $1,240 from Oct 18.`,
							)}
						/>
					</Shot>
					<Rule>
						The line keeps its past months. An account you add counts from its
						first balance, so the line steps on that day. The sentence's change
						leaves that first balance out and says so.
					</Rule>
				</Choice>

				<Choice
					name="C: mark the day on the line"
					note="Same line and the same sentence as now. A ring sits on the line where Apple Card started, and a key under the dates says what it is."
					cost="One more mark to read; a ring near the line's end sits close to its end dot."
				>
					<Shot caption="Apple Card, owed $1,240">
						<Accounts
							label={`Option C: ${whole(cardChange)} up since May, a ring on Oct 18 and its key`}
							points={CARD}
						/>
					</Shot>
					<Rule>
						The line keeps its past months. An account you add counts from its
						first balance, so the line steps on that day, marked with a ring and
						named under the line.
					</Rule>
				</Choice>
			</Choices>
		</Specimen>
	);
}

// P74: motion. The owner shared a list of micro-interaction libraries (toggles.dev, Blendy, ssgoi,
// cuelume, somonoco) as inspiration. Tally can't add them (no client framework, and no new script or
// dependency without a decision; the CSP is style-src 'self', so no inline style attributes), so
// this draws the motion CSS alone could give it, with the browser's own View Transitions for page
// changes. Each option is one picture of four moments, each looping at its real speed with a pause,
// starting on its end state; under reduced motion each rests on that end state. Option A is
// decided and built (decision 76, P74 A): its sheet, toast, desktop panel and switch are drawn with
// the real classes from app.css (sheet-rise, fade-in, toast-motion, switch-knob, switch-track),
// replayed by the stage's loop. A switch's own move is a transition, which only a tap starts, so the
// loop runs the real knob and track as an animation, from On to the Off they rest on. What the loop
// alone draws is what wasn't picked: B's morph and sliding pages.

import type { Child } from "hono/jsx";
import type { ListRow } from "../db/transactions";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { Switch } from "../views/switch";
import { TransactionRow } from "../views/transaction-row";
import { Fixed, Options } from "./proposal-parts";
import { NeedsLine } from "./proposals-phase5-transactions";
import { Specimen } from "./specimen";

/** What the browser and htmx give us, checked against their docs, so no option promises more. */
function Gives({ children }: { children?: Child }) {
	return (
		<p class="max-w-prose text-sm">
			<span class="font-medium">What the browser gives us: </span>
			{children}
		</p>
	);
}

/** The Costco row as the list loads it; amounts are Plaid's way round (positive is money out). */
const COSTCO: ListRow = {
	id: 1,
	date: "2026-10-03",
	amountCents: 14260,
	rawName: "Costco",
	displayName: "Costco",
	note: null,
	excluded: false,
	income: false,
	creditReviewed: true,
	categoryId: 1,
	categoryName: "Groceries",
	categoryIcon: "groceries",
	categoryColor: "cat-blue",
};

// ---------------------------------------------------------------------------------------------
// The three looks. "quiet" is A, "more" is B and "none" is C (today's).

type Look = "quiet" | "more" | "none";

/**
 * A stage replays the real classes inside it (the sheet, the backdrop, the toast, the switch's knob
 * and track), and loops --proposal-t from 0 to 1 and back for B's morph and sliding pages (app.css,
 * "The proposals page's drawings"). A move's real length decides the loop's: 150 ms takes 4.5 s and
 * 200 ms takes 6 s. "None" jumps instead of easing, so each change is a cut.
 */
function loop(look: Look, ms: 150 | 200) {
	return [
		"proposal-loop",
		ms === 200 ? "proposal-200" : "",
		look === "none" ? "proposal-cut" : "",
	]
		.filter(Boolean)
		.join(" ");
}

type MomentProps = {
	n: number;
	title: string;
	/** What moves, in words, so a still screenshot says it too. */
	words: string;
	/** The stage's height class. */
	height: string;
	look: Look;
	ms: 150 | 200;
	children?: Child;
};

/** One moment: its name, a stage that loops, and what it does in words. */
function Moment({ n, title, words, height, look, ms, children }: MomentProps) {
	return (
		<div class="flex flex-col gap-1">
			<p class="text-sm font-medium">
				{n} · {title}
			</p>
			<div
				class={`relative overflow-hidden rounded-control border border-rule bg-paper ${height} ${loop(look, ms)}`}
			>
				{children}
			</div>
			<p class="text-sm text-muted">{words}</p>
		</div>
	);
}

/**
 * 1 · The P41 switch (decision 73: On or Off in words, one Save under the group) turning off. It is
 * the real Switch, drawn Off: its real knob and track, which the loop slides from the On look, so a
 * still capture shows the end of the move. The row is P41 B's own: its name and its muted line.
 */
function SwitchStage({ look }: { look: Look }) {
	return (
		<div class="flex h-full items-center px-4">
			<div class="w-full">
				<Switch
					id={`p74-${look}-switch`}
					name={`p74-${look}-switch`}
					label="Income"
					hint="Spots paychecks and other money coming in."
				/>
			</div>
		</div>
	);
}

/**
 * 2 · A sheet opening over the list (a tap on a row in Transactions). The backdrop fades and the
 * sheet rises. With the morph (B), the tapped row's name leaves its row and becomes the sheet's
 * title; without it, the title simply comes up with the sheet.
 */
function SheetStage({ look }: { look: Look }) {
	const title = (
		<h2 class="font-serif text-4xl font-semibold leading-10 tracking-tight">
			Costco
		</h2>
	);
	return (
		<>
			<ul class="divide-y divide-rule px-4">
				<TransactionRow row={COSTCO} />
			</ul>
			<div class="fade-in absolute inset-0 bg-ink/30" />
			<div class="sheet-rise absolute inset-x-0 bottom-0 flex h-24 flex-col rounded-t-sheet bg-paper p-4">
				{look === "more" ? <div class="h-10" /> : title}
				<p class="text-muted">$142.60 · Groceries</p>
			</div>
			{look === "more" && (
				<div class="proposal-morph absolute left-4 top-20 origin-left">
					{title}
				</div>
			)}
		</>
	);
}

/**
 * 3 · A toast arriving, with its fade out when it leaves. Toast.js draws it where Layout's #toasts
 * sits, without the shadow here (the token test allows that only in toast.js).
 */
function ToastStage() {
	return (
		<div class="absolute inset-x-4 bottom-3 flex justify-center">
			<p
				role="status"
				class="toast-motion rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink"
			>
				Saved Costco
			</p>
		</div>
	);
}

/**
 * 4 · Going from Transactions to a page of its own. A transaction opens as the sheet in 2, so the
 * page drawn here is Organize, which Transactions links to when it's showing what needs a category.
 * The old page goes and the new one arrives: a plain cross-fade (A), a slide to the left as the
 * next page comes in from the right (B), or a cut (C). The titles are drawn smaller than the real
 * ones (5xl) so the sheet's title in 2 stays the loudest thing here.
 */
function PageStage({ look }: { look: Look }) {
	const more = look === "more";
	return (
		<>
			<div
				class={`absolute inset-0 px-4 pt-3 ${more ? "proposal-slide-out" : ""}`}
			>
				<p class="font-serif text-2xl font-semibold tracking-tight">
					Transactions
				</p>
				<p class="mt-1 text-sm text-muted">
					4 transactions needing a category in October
				</p>
				<Button kind="text" href="/transactions/organize">
					Organize by merchant
				</Button>
			</div>
			<div
				class={`absolute inset-0 bg-paper px-4 pt-3 ${more ? "proposal-slide-in" : "fade-in"}`}
			>
				<p class="font-serif text-2xl font-semibold tracking-tight">Organize</p>
				<p class="text-muted">1 of 3 · 4 left, all months</p>
				<div class="mt-2 flex gap-2">
					<Chip
						type="radio"
						name={`p74-${look}-category`}
						value="household"
						icon={<CategoryIcon icon="household" color="cat-brown" />}
					>
						Household
					</Chip>
					<Chip
						type="radio"
						name={`p74-${look}-category`}
						value="groceries"
						icon={<CategoryIcon icon="groceries" color="cat-blue" />}
					>
						Groceries
					</Chip>
				</div>
			</div>
		</>
	);
}

const WORDS: Record<Look, [string, string, string, string]> = {
	quiet: [
		"The knob slides from On to Off in 150 ms and the tones swap; on the real switch the word changes with it.",
		"The sheet rises in 200 ms; the backdrop fades in.",
		"Fades in and rises 8 px in 150 ms, then fades out.",
		"The old page cross-fades into the new in 150 ms.",
	],
	more: [
		"The knob slides from On to Off in 150 ms and the tones swap; on the real switch the word changes with it.",
		"As A, and the row's name glides into the title.",
		"Fades in and rises 8 px in 150 ms, then fades out.",
		"The page slides left as the next comes in, 200 ms.",
	],
	none: [
		"The knob and the tones change at once.",
		"The sheet and its backdrop appear at once.",
		"It appears, then disappears.",
		"The new page replaces the old at once.",
	],
};

/** One option's picture: the same four moments, moving as that option would. */
function Moments({ look }: { look: Look }) {
	const [sw, sheet, toast, page] = WORDS[look];
	return (
		<div class="flex flex-col gap-3">
			<Moment
				n={1}
				title="The switch turns off"
				words={sw}
				height="h-28"
				look={look}
				ms={150}
			>
				<SwitchStage look={look} />
			</Moment>
			<Moment
				n={2}
				title="The sheet opens"
				words={sheet}
				height="h-40"
				look={look}
				ms={200}
			>
				<SheetStage look={look} />
			</Moment>
			<Moment
				n={3}
				title="A toast arrives and leaves"
				words={toast}
				height="h-[4.5rem]"
				look={look}
				ms={150}
			>
				<ToastStage />
			</Moment>
			<Moment
				n={4}
				title="Transactions to Organize"
				words={page}
				height="h-32"
				look={look}
				ms={look === "more" ? 200 : 150}
			>
				<PageStage look={look} />
			</Moment>
		</div>
	);
}

/** P74 on the proposals page, open for the owner's pick. */
export function P74() {
	return (
		<Specimen
			id="p74-motion"
			title="P74 · Motion"
			tier="visual"
			sentence="Four moments, drawn the same way in each option: the switch turning off, a sheet opening, a toast, and going from Transactions to another page. The libraries shared as inspiration (toggles.dev, Blendy, ssgoi, cuelume, somonoco) can't come in as they are, so this is what CSS alone can do; Cuelume's sounds are already on the Later list, after this. Each picture loops at its real speed with a pause between, starting on its end state. If nothing moves for you, your device is set to reduce motion, and each picture rests on its end state, which is what people with that setting would get."
		>
			<Fixed>
				DESIGN.md's Scenery table: motion confirms that something happened and
				never decorates, bounces or delays, and reduced motion shows the end
				state. Today that's the bars filling on load, a field shaking once, a
				disclosure's chevron turning and the busy ring spinning. There's no
				count-up (it would need custom JavaScript) and no new script without a
				decision (45), so the libraries' own code can't come in. The CSP is
				style-src 'self', so every move is a class in app.css, never an inline
				style.
			</Fixed>
			<Gives>
				View Transitions are the browser's own cross-fade, with no script. For
				page changes, one rule in app.css,{" "}
				<code>
					@view-transition {"{"} navigation: auto; {"}"}
				</code>
				, turns it on for same-origin links; both pages need it, and Layout
				loads app.css on every page. By MDN's compatibility data, Chrome and
				Edge (126 and later) and Safari (18.2 and later) play it and Firefox
				doesn't yet, so there pages switch at once, as today. Inside a page,
				htmx 4 can wrap a swap in the same kind of transition (Chrome 111,
				Safari 18 and Firefox 144 and later), but only when asked: its{" "}
				<code>transitions</code> setting is off, a <code>htmx-config</code> meta
				tag turns it on for every swap, and <code>transition:true</code> in{" "}
				<code>hx-swap</code> for one. The browser's cross-fade lasts 250 ms
				unless CSS sets another length.
			</Gives>
			<NeedsLine>
				Under reduced motion the page rule sits inside a{" "}
				<code>prefers-reduced-motion: no-preference</code> query, so pages
				switch at once. htmx's <code>transitions</code> setting stays off, so a
				filter or one of Adjust's taps never fades the whole page. A toast's
				fade-out is part of its own 4-second animation, set in CSS on what{" "}
				<code>#toasts</code> holds and matching toast.js's 4 seconds, so that
				script doesn't change. Already settled (decisions 76 and 79): motion is
				CSS only, each in 150 to 200 ms, with durations as tokens in app.css
				that the older animations move onto too; View Transitions are an
				enhancement, so a browser without them just switches pages; under
				reduced motion everything shows its end state; and every motion is
				written into its component's use spec.
			</NeedsLine>
			<Options
				options={[
					{
						name: "Option A · Quiet confirmations",
						picked: true,
						note: "Four small moves. The switch's knob slides in 150 ms ease-out and the word changes with it; the sheet rises in 200 ms ease-out as its backdrop fades in; a toast fades in and rises 8 px in 150 ms; and a page change cross-fades in 150 ms through View Transitions.",
						tradeoff:
							"the page cross-fade shows only in browsers that have it; in the others, pages switch at once, as today.",
						recommended:
							"each move says something happened, and is over before you notice it.",
						family: true,
						screen: <Moments look="quiet" />,
					},
					{
						name: "Option B · A little more",
						note: "As A, plus the tapped row's name glides into the sheet's title (a named view transition, as Blendy does) and the page slides left when going deeper, the next one coming in from the right (as ssgoi does), both in 200 ms.",
						tradeoff:
							"more to build and test; with no inline styles, CSS alone can't name just the tapped row for the morph, or tell going deeper from going back for the slide, so both likely need a small script (a new allowed-JS decision); and morphs can feel slow on old phones.",
						family: true,
						screen: <Moments look="more" />,
					},
					{
						name: "Option C · None",
						note: "Today's: the bars fill and a field shakes once, a chevron turns and a busy ring spins; every other change is a cut.",
						tradeoff:
							"calm and nothing to build, but things appear abruptly, so it's easy to miss what changed.",
						family: true,
						screen: <Moments look="none" />,
					},
				]}
			/>
		</Specimen>
	);
}

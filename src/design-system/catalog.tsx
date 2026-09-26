// The catalog's content (decisions 42–44): every component from src/views/, imported and given
// typed fake data, so what's shown here is exactly what the app renders.
import type { Child } from "hono/jsx";
import { Band } from "../views/band";
import { BottomSheet } from "../views/bottom-sheet";
import { TallyMark, Wordmark } from "../views/brand";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { FormField } from "../views/form-field";
import {
	BudgetDiagram,
	CategoriesDiagram,
	ExclusionsDiagram,
	TransactionsDiagram,
} from "../views/how-diagrams";
import { HowLink } from "../views/how-link";
import { ICON_NAMES, Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { MoneyInput } from "../views/money-input";
import { ProgressRow } from "../views/progress-row";
import { SystemDiagram } from "../views/system-diagram";
import { ThingsToTry } from "../views/things-to-try";
import { TransactionRow } from "../views/transaction-row";
import {
	BAND,
	BUDGET_EXAMPLE,
	CATEGORIES_EXAMPLE,
	EXCLUSIONS_EXAMPLE,
	MONEY_STATES,
	PROGRESS_ROWS,
	TRANSACTION_ROWS,
	TRANSACTIONS_EXAMPLE,
} from "./mock";
import { Specimen, State, TierPill } from "./specimen";
import { CATEGORY_COLORS, COLOR_TOKENS, TYPE_ROLES } from "./tokens";

// The catalog's own buttons, in Settings' outline style; a Button component comes later in #76.
const catalogButton =
	"inline-flex min-h-11 items-center justify-center rounded-control border border-ink px-5 text-ink no-underline";

const SECTIONS = [
	["foundation", "Foundation"],
	["brand", "Brand and icons"],
	["shell", "Page shell"],
	["rows", "Rows"],
	["controls", "Controls"],
	["feedback", "Feedback and sheets"],
	["demo", "Demo only"],
	["diagrams", "Diagrams"],
] as const;

function Group({
	id,
	title,
	children,
}: {
	id: (typeof SECTIONS)[number][0];
	title: string;
	children?: Child;
}) {
	return (
		<section id={id} aria-labelledby={`${id}-title`} class="mt-12">
			<h2 id={`${id}-title`} class="font-serif text-3xl font-semibold">
				{title}
			</h2>
			{children}
		</section>
	);
}

function Intro() {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				Design system
			</h1>
			<p class="mt-3 max-w-prose text-lg">
				Every part of Tally's interface, in each of its states. Each one is the
				real component the app uses, given sample data, so this page can't show
				something the app doesn't. The rules are in DESIGN.md.
			</p>
			<dl class="mt-6 grid gap-3 sm:grid-cols-3">
				{(
					[
						[
							"visual",
							"Static states side by side. Nothing here can reach the server.",
						],
						[
							"interactive",
							"Works in your browser without the server: try it.",
						],
						[
							"flow",
							"A journey of several steps, on its own page. The first flows come next.",
						],
					] as const
				).map(([tier, text]) => (
					<div class="flex flex-col items-start gap-1">
						<dt>
							<TierPill tier={tier} />
						</dt>
						<dd class="text-muted">{text}</dd>
					</div>
				))}
			</dl>
			<nav aria-label="Catalog sections" class="mt-6">
				<ul class="flex flex-wrap gap-x-5">
					{SECTIONS.map(([id, title]) => (
						<li>
							<a href={`#${id}`} class="inline-flex min-h-11 items-center">
								{title}
							</a>
						</li>
					))}
				</ul>
			</nav>
		</>
	);
}

function Foundation() {
	return (
		<Group id="foundation" title="Foundation">
			<Specimen
				id="colors"
				title="Colors"
				tier="visual"
				sentence="Every color token, its use, and its contrast on paper. Status and category colors never share a hue."
			>
				<ul class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{COLOR_TOKENS.map((t) => (
						<li class="flex items-center gap-3">
							<span
								class={`size-12 shrink-0 rounded-control border border-rule ${t.swatch}`}
							/>
							<span class="min-w-0">
								<span class="block font-medium">
									{t.name} <span class="text-muted">{t.hex}</span>
								</span>
								<span class="block text-sm text-muted">
									{t.use} · {t.contrast}
								</span>
							</span>
						</li>
					))}
				</ul>
			</Specimen>
			<Specimen
				id="type"
				title="Type roles"
				tier="visual"
				sentence="Newsreader for the one thing that matters on a screen; Inter with tabular numerals for everything else."
			>
				{TYPE_ROLES.map((r) => (
					<State label={`${r.role} · ${r.classes}`}>
						<p class={r.classes}>{r.sample}</p>
					</State>
				))}
			</Specimen>
			<Specimen
				id="radii"
				title="Radii and depth"
				tier="visual"
				sentence="Two radii and pills. No shadows except toasts: hairline rules separate things instead."
			>
				<div class="flex flex-wrap gap-6">
					<State label="rounded-control · inputs, chips, buttons">
						<span class="block h-16 w-28 rounded-control border border-ink" />
					</State>
					<State label="rounded-sheet · the sheet's top corners">
						<span class="block h-16 w-28 rounded-t-sheet border border-ink" />
					</State>
					<State label="rounded-full · pills, round buttons">
						<span class="block h-11 w-28 rounded-full border border-ink" />
					</State>
				</div>
			</Specimen>
			<Specimen
				id="motion"
				title="Motion"
				tier="visual"
				sentence="Budget bars fill on load; with reduced motion they show their final state. Nothing counts up or bounces."
			>
				<ul>
					{PROGRESS_ROWS.slice(0, 1).map((s) => (
						<ProgressRow {...s.props} />
					))}
				</ul>
			</Specimen>
		</Group>
	);
}

function Brand() {
	return (
		<Group id="brand" title="Brand and icons">
			<Specimen
				id="wordmark"
				title="Wordmark and TallyMark"
				tier="visual"
				components={["Wordmark", "TallyMark"]}
				sentence="The tally-mark glyph plus serif “Tally”; the brand."
			>
				<div class="flex flex-wrap items-center gap-8">
					<Wordmark />
					<span class="text-ink">
						<TallyMark class="size-12" />
					</span>
				</div>
			</Specimen>
			<Specimen
				id="icon"
				title="Icon"
				tier="visual"
				components={["Icon"]}
				sentence="Lucide line icons, 1.75 stroke, currentColor, always aria-hidden."
			>
				<ul class="grid grid-cols-3 gap-4 sm:grid-cols-6 lg:grid-cols-8">
					{ICON_NAMES.map((name) => (
						<li class="flex flex-col items-center gap-1 text-center">
							<Icon name={name} />
							<span class="text-xs text-muted">{name}</span>
						</li>
					))}
				</ul>
			</Specimen>
			<Specimen
				id="category-icon"
				title="CategoryIcon"
				tier="visual"
				components={["CategoryIcon"]}
				sentence="A category's line icon, drawn in its color token."
			>
				<ul class="flex flex-wrap gap-6">
					{CATEGORY_COLORS.map((color) => (
						<li class="flex flex-col items-center gap-1">
							<CategoryIcon icon="groceries" color={color} />
							<span class="text-xs text-muted">{color}</span>
						</li>
					))}
				</ul>
			</Specimen>
			<Specimen
				id="illustration"
				title="LedgerIllustration"
				tier="visual"
				components={["LedgerIllustration"]}
				sentence="The notebook-and-pencil line drawing beside the headline; ink plus a terracotta pencil."
			>
				<LedgerIllustration />
			</Specimen>
		</Group>
	);
}

function Shell() {
	return (
		<Group id="shell" title="Page shell">
			<Specimen
				id="layout"
				title="Layout, Sidebar and BottomTabs"
				tier="visual"
				components={["Layout", "Sidebar", "BottomTabs"]}
				sentence="Every page's shell: banner, navigation, main, toast and announce regions. The same destinations are a sidebar on desktop and four tabs plus More on phones."
			>
				<p class="max-w-prose">
					This page is drawn inside the real Layout, so its demo banner,
					navigation, toast region and announcer are the app's own. Widen or
					narrow the window to see the sidebar and the tabs. No item is current
					here, because the catalog isn't one of the destinations.
				</p>
			</Specimen>
		</Group>
	);
}

function Rows() {
	return (
		<Group id="rows" title="Rows">
			<Specimen
				id="progress-row"
				title="ProgressRow"
				tier="visual"
				components={["ProgressRow"]}
				sentence="One category: icon, name, “spent of budget,” and an SVG bar with a notch at the limit; over budget adds an alert icon and the words “over budget.” In the app each row opens its budget sheet; here they don't link anywhere."
			>
				{PROGRESS_ROWS.map((s) => (
					<State label={s.label}>
						<ul class="max-w-xl">
							<ProgressRow {...s.props} />
						</ul>
					</State>
				))}
			</Specimen>
			<Specimen
				id="transaction-row"
				title="TransactionRow"
				tier="visual"
				components={["TransactionRow"]}
				sentence="One transaction as a single link to its edit panel: icon, name, category or status in words, signed amount. Here the rows don't link anywhere."
			>
				{TRANSACTION_ROWS.map((s) => (
					<State label={s.label}>
						<ul class="max-w-xl">
							<TransactionRow row={s.row} />
						</ul>
					</State>
				))}
			</Specimen>
			<Specimen
				id="band"
				title="Band"
				tier="visual"
				components={["Band"]}
				sentence="The one tinted row per screen that links to the thing to do next. This one opens the demo's real list of transactions that need a category."
			>
				<div class="max-w-xl">
					<Band href={BAND.href}>{BAND.text}</Band>
				</div>
			</Specimen>
		</Group>
	);
}

function Controls() {
	return (
		<Group id="controls" title="Controls">
			<Specimen
				id="chip"
				title="Chip"
				tier="interactive"
				components={["Chip"]}
				sentence="A pill-shaped checkbox or radio; the real input is visually hidden but keyboard-reachable. A checkbox chip shows a check mark while on, so its state isn't color alone."
			>
				<fieldset>
					<legend class="text-sm font-medium text-muted">
						Radio chips: pick one (arrow keys move)
					</legend>
					<div class="mt-2 flex flex-wrap gap-2">
						<Chip
							type="radio"
							name="ds-category"
							value="groceries"
							checked
							icon={<CategoryIcon icon="groceries" color="cat-blue" />}
						>
							Groceries
						</Chip>
						<Chip
							type="radio"
							name="ds-category"
							value="eating-out"
							icon={<CategoryIcon icon="eating-out" color="cat-plum" />}
						>
							Eating out
						</Chip>
						<Chip
							type="radio"
							name="ds-category"
							value="gas"
							icon={<CategoryIcon icon="gas" color="cat-slate" />}
						>
							Gas
						</Chip>
					</div>
				</fieldset>
				<fieldset>
					<legend class="text-sm font-medium text-muted">
						Checkbox chips: toggles, on and off
					</legend>
					<div class="mt-2 flex flex-wrap gap-2">
						<Chip type="checkbox" name="ds-always" value="1" checked>
							Always for this merchant
						</Chip>
						<Chip type="checkbox" name="ds-exclude" value="1">
							Exclude from budget
						</Chip>
					</div>
				</fieldset>
			</Specimen>
			<Specimen
				id="form-field"
				title="FormField"
				tier="visual"
				components={["FormField"]}
				sentence="A labeled control, with its error shown in role=“alert”."
			>
				{/* The input is Settings' name field; a text input component comes with Button in #76. */}
				{[
					["Default", "ds-name", "Groceries", undefined],
					["With an error", "ds-name-error", "", "Give the category a name."],
				].map(([label, id, value, error]) => (
					<State label={label as string}>
						<FormField id={id as string} label="Name" error={error}>
							{(a11y) => (
								<input
									id={id}
									value={value}
									autocomplete="off"
									class="min-h-11 rounded-control border border-rule bg-band px-3 text-lg sm:max-w-sm"
									{...a11y}
								/>
							)}
						</FormField>
					</State>
				))}
			</Specimen>
			<Specimen
				id="money-input"
				title="MoneyInput"
				tier="interactive"
				components={["MoneyInput"]}
				sentence="The owner's hero amount from the original app: ±$1 round buttons, ▲▼ cent arrows inside the field, Round-to and Last-month chips. Try the buttons, the chips and the ↑ ↓ keys."
			>
				{MONEY_STATES.map((s) => (
					<State label={s.label}>
						<MoneyInput {...s.props} />
					</State>
				))}
			</Specimen>
		</Group>
	);
}

function Feedback() {
	return (
		<Group id="feedback" title="Feedback and sheets">
			<Specimen
				id="toast"
				title="Toast"
				tier="interactive"
				sentence="After an HTMX change the server sends HX-Trigger with toast and announce; toast.js shows the message for four seconds and the announcer reads it. These buttons send the same events."
			>
				<div class="flex flex-wrap gap-3">
					<button
						type="button"
						data-ds-toast="success"
						data-ds-message="Saved Groceries' budget."
						class={catalogButton}
					>
						Show a saved toast
					</button>
					<button
						type="button"
						data-ds-toast="error"
						data-ds-message="That didn't save. Try again."
						class={catalogButton}
					>
						Show an error toast
					</button>
				</div>
			</Specimen>
			<Specimen
				id="bottom-sheet"
				title="BottomSheet"
				tier="visual"
				components={["BottomSheet"]}
				sentence="A page region over the list (bottom sheet on phones, right-hand panel on desktop) with a dimmed backdrop; not a modal, closed by Cancel or the backdrop."
			>
				<p>
					It covers the page, so it has a page of its own:{" "}
					<a
						href="/design-system/bottom-sheet"
						class="inline-flex min-h-11 items-center"
					>
						see the bottom sheet
					</a>
					.
				</p>
			</Specimen>
		</Group>
	);
}

function Demo() {
	return (
		<Group id="demo" title="Demo only">
			<Specimen
				id="things-to-try"
				title="ThingsToTry"
				tier="visual"
				components={["ThingsToTry"]}
				sentence="The demo's bordered “New here? Things to try” block at the top of Home: three links to where each thing is done, plus How Tally works."
			>
				<ThingsToTry />
			</Specimen>
			<Specimen
				id="how-link"
				title="HowLink"
				tier="visual"
				components={["HowLink"]}
				sentence="A small “How this works” link under a screen's title to its section of How Tally works; renders nothing outside the demo."
			>
				<HowLink section="budget" demo />
			</Specimen>
		</Group>
	);
}

function Diagrams() {
	return (
		<Group id="diagrams" title="Diagrams">
			<Specimen
				id="system-diagram"
				title="SystemDiagram"
				tier="visual"
				components={["SystemDiagram"]}
				sentence="The inline SVG diagram of Tally's parts on How Tally works; scales to the screen width, with a title and description for screen readers."
			>
				<SystemDiagram />
			</Specimen>
			<Specimen
				id="how-diagrams"
				title="How Tally works' section diagrams"
				tier="visual"
				components={[
					"BudgetDiagram",
					"TransactionsDiagram",
					"ExclusionsDiagram",
					"CategoriesDiagram",
				]}
				sentence="Drawn from the same numbers as each worked example. A dashed outline means “not counted” or “not decided yet.” These use sample numbers."
			>
				<State label="BudgetDiagram">
					<BudgetDiagram {...BUDGET_EXAMPLE} />
				</State>
				<State label="TransactionsDiagram">
					<TransactionsDiagram {...TRANSACTIONS_EXAMPLE} />
				</State>
				<State label="ExclusionsDiagram">
					<ExclusionsDiagram {...EXCLUSIONS_EXAMPLE} />
				</State>
				<State label="CategoriesDiagram">
					<CategoriesDiagram {...CATEGORIES_EXAMPLE} />
				</State>
			</Specimen>
		</Group>
	);
}

/** The whole catalog page body. */
export function Catalog() {
	return (
		<>
			<Intro />
			<Foundation />
			<Brand />
			<Shell />
			<Rows />
			<Controls />
			<Feedback />
			<Demo />
			<Diagrams />
		</>
	);
}

/** The bottom sheet over sample rows, as it sits over Home or Transactions. */
export function SheetSpecimen() {
	return (
		<>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				BottomSheet
			</h1>
			<p class="mt-2 text-muted">
				Visual: the sheet over sample rows. Cancel or the backdrop go back to
				the catalog.
			</p>
			<ul class="mt-6 max-w-xl">
				{PROGRESS_ROWS.map((s) => (
					<ProgressRow {...s.props} />
				))}
			</ul>
			<div hx-ignore="">
				<BottomSheet
					labelledBy="ds-sheet-title"
					closeHref="/design-system#bottom-sheet"
				>
					<h2
						id="ds-sheet-title"
						class="font-serif text-4xl font-semibold tracking-tight"
					>
						Groceries
					</h2>
					<p class="mt-2 text-muted">
						On phones it rises from the bottom; on desktop it's a panel on the
						right. It isn't a modal: the page behind it stays in place.
					</p>
					<a
						href="/design-system#bottom-sheet"
						class="mt-6 inline-flex min-h-11 items-center justify-center rounded-control border border-ink px-5 text-ink no-underline"
					>
						Cancel
					</a>
				</BottomSheet>
			</div>
		</>
	);
}

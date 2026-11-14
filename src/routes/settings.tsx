import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { type Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { actor } from "../actor";
import { addressOf } from "../address";
import { askAgainLeftOut, leftOutSentence } from "../categorize-pending";
import { householdTimeZone, householdToday, todayIn } from "../dates";
import { type AiTallyCounts, readAiTally } from "../db/ai-log";
import {
	type AiSwitches,
	type FormSwitch,
	readAiSwitches,
	switchNamed,
} from "../db/ai-switches";
import { categoryNames, settingsCategories } from "../db/categories";
import {
	addCategoryStatements,
	archiveCategoryStatements,
	decideCategory,
	moveCategoryStatements,
	renameCategoryStatements,
	restoreCategoryStatements,
	saveNamedCategory,
} from "../db/category-saves";
import {
	createFromSuggestion,
	decideDismiss,
	type PendingSuggestion,
	pendingSuggestionPage,
} from "../db/category-suggestions";
import { type Database, runWith } from "../db/database";
import { isUniqueViolation } from "../db/errors";
import {
	displayName,
	FORGET_UNDO_MIN_MS,
	learnedCategoryChoices,
	loadLearnedLines,
} from "../db/learned-lines";
import { merchantRules } from "../db/merchant-rules";
import {
	type NeverSuggestRule,
	neverSuggestRuleLine,
	neverSuggestRules,
} from "../db/never-suggest";
import { readBankSignInEmails } from "../db/reconnect";
import { runningRecheck, startResortFor } from "../db/resort-start";
import {
	addPersonStatements,
	addressFacts,
	aiSwitchesFacts,
	aiSwitchesStatements,
	alwaysRuleFacts,
	bankSignInEmailsStatements,
	changeLineFacts,
	changeLineStatements,
	decideSetting,
	forgetStatements,
	forgetUndoLeftMs,
	neverSuggestLineFacts,
	noFacts,
	personFacts,
	personNameTaken,
	removeAddressStatements,
	removeAlwaysRuleStatements,
	removeNeverSuggestStatements,
	removePersonStatements,
	renamePersonStatements,
	textVersion,
	timeZoneStatements,
	undoForgetFacts,
	undoForgetStatements,
} from "../db/settings-saves";
import { suggestionQueue } from "../db/suggestions-queue";
import { readAtEdge } from "../edge";
import {
	CardPlace,
	PersonName,
	rowIdOf,
	rowIdOrZero,
	rowIdsOf,
	SignInAddress,
	textOf,
} from "../edge-kinds";
import { hxTrigger } from "../htmx";
import { MERCHANT_KEY_MAX } from "../limits";
import { reconnectRecipients } from "../reconnect/reminders";
import { STARTED_ANNOUNCEMENT } from "../resort-toast";
import {
	addCategory,
	archiveCategory,
	type CategoryFacts,
	moveCategory,
	renameCategory,
	restoreCategory,
} from "../rules/categories";
import {
	addPerson,
	type ChangeLineWrite,
	changeLine,
	forgetLine,
	removeAlwaysRule,
	removeNeverSuggestLine,
	removePerson,
	removeSignInAddress,
	renamePerson,
	saveAiSwitches as saveAiSwitchesRule,
	saveBankSignInEmails as saveBankSignInEmailsRule,
	saveTimeZone as saveTimeZoneRule,
	undoForget,
} from "../rules/settings";
import { dismissNewCategory } from "../rules/suggestions";
import type { Refusal } from "../rules/terms";
import {
	type CategoryErrors,
	CategoryId,
	CategoryName,
	MoveDirection,
	sameName,
} from "../settings/category-form";
import { tallyExport, transactionsCsv } from "../settings/export";
import { parseTimeZone, zoneLabel } from "../settings/time-zones";
import { tidyName } from "../transactions/tidy-name";
import { AiTally } from "../views/ai-tally";
import { BankSignInEmails } from "../views/bank-sign-in-emails";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import {
	AddCategoryRow,
	CategoryRow,
	chevron,
	summaryClass,
	swap,
} from "../views/category-row";
import { EmptyState } from "../views/empty-state";
import { HouseholdPeople } from "../views/household-people";
import { Layout } from "../views/layout";
import { LearnedPage } from "../views/learned-page";
import {
	MERCHANT_RULE_SEARCH_THRESHOLD,
	MerchantRules,
} from "../views/merchant-rules";
import { RecheckLine } from "../views/recheck-line";
import {
	SettingsContents,
	SubpageHead,
	settingsPlaces,
} from "../views/settings-pages";
import { NewCategoryCard } from "../views/suggestion-card";
import { AskFirst } from "../views/suggestion-review";
import { Switch } from "../views/switch";
import { TimeZoneRow } from "../views/time-zone-row";
import {
	askedStores,
	CHANGED_SUGGESTION,
	neverSuggestedMessage,
	writeNeverSuggest,
} from "./suggestions";

type App = { Bindings: Env };

export const settings = new Hono<App>();

const ruleFocus = (
	renderedRules: { merchantKey: string }[],
	removedKey: string,
) => {
	const index = renderedRules.findIndex(
		(rule) => rule.merchantKey === removedKey,
	);

	return {
		focusRuleIndex:
			renderedRules.length > 1
				? Math.min(
						index < renderedRules.length - 1 ? index : index - 1,
						renderedRules.length - 2,
					)
				: undefined,
		focusMerchantHeading: renderedRules.length <= 1,
	};
};

/** The Settings pages (decision 120): the contents page, then one page for each of its six sections. */
type Page =
	| "categories"
	| "rules"
	| "learned"
	| "household"
	| "people"
	| "ai"
	| "data";

type View = {
	/** The row to show open: a category's id, or "new" for Add category. */
	open?: number | "new";
	/**
	 * The row a Settings save just changed: its chevron gives way to the pencil tick for the toast's stay (P119 A,
	 * #71). Only a save's own row is marked: a category's rename or add, the time zone, a person's rename or add. Nothing
	 * else is (archive, restore, move, remove, suggestions, the AI switches, a 422).
	 */
	saved?:
		| { kind: "category"; id: number }
		| { kind: "zone" }
		| { kind: "person"; id: number };
	/** Move focus here after a swap: a row's summary, the Archived summary, the Time zone row, or a bank sign-in email control. */
	focus?:
		| number
		| "archived"
		| "zone"
		| "bank-sign-in-email-switch"
		| "bank-sign-in-email-summary"
		| "bank-sign-in-email-remove";
	/** Keeps the "Who gets them" disclosure open after a swap. */
	bankSignInEmailsOpen?: boolean;
	/** The address whose Remove button takes focus after a swap. */
	bankSignInEmailFocusEmail?: string;
	/** Focus the remaining merchant rule at this list position, or the Always heading when the list is empty. */
	focusRuleIndex?: number;
	focusMerchantHeading?: boolean;
	/** Focus the "Never suggest" line at this position after a Remove, or the one line that says none. */
	focusNever?: { index?: number; heading?: boolean };
	merchantRuleError?: string;
	/** A What Tally has learned Forget refused (no text chosen). */
	learnedError?: string;
	/** A What Tally has learned Change refused for its own line: that line opens with the refusal in it (decision 163). */
	learnedChange?: { cleanedText: string; error: string };
	/** What was typed, shown again with the errors. */
	values?: { name: string };
	errors?: CategoryErrors;
	/** Why a restore didn't happen. */
	restoreError?: string;
	/** Why the change didn't happen, shown above the list. */
	listError?: string;
	suggestionError?: string;
	suggestionValues?: {
		id: number;
		ticked: number[];
		notes: Record<number, string>;
	};
	/** The question after a No on a suggested category, drawn in its card's place (decisions 101, 120). */
	ask?: {
		/** The suggestion's number: the question's answer posts to its dismiss address. */
		suggestionId: number;
		/** The question's id: "new-" and the suggestion's number. */
		id: string;
		name: string;
		stores: { merchantKey: string; label: string }[];
		/** The No's card place in the list; left out, the question comes after every card. */
		place?: number;
	};
	status?: 200 | 400 | 404 | 409 | 422 | 503;
	/** The household's date and time zone, when the handler already read them, so the request reads them once. */
	today?: string;
	timeZone?: string;
	/** Why the posted time zone wasn't saved, shown under its select. */
	zoneError?: string;
	bankSignInEmailError?: string;
	peopleOpen?: number;
	peopleAddOpen?: boolean;
	peopleError?: string;
	peopleErrorPersonId?: number;
	peopleValue?: string;
	/** Focus the People page's title: after an add or a removal, or when Cancel comes back to the page. */
	peopleFocus?: boolean;
	/** The AI switch that was flipped: focus stays on it after the save, the page drawn again (#606). */
	aiFocus?: keyof AiSwitches;
	rulesSearch?: string;
};

/** A save's answer: the page it lives on (htmx gets that page; a plain browser goes to it), with the view it draws. */
type Done = View & { page: Page };

/**
 * The AI suggestions switches that have a feature behind them (spec §8.6, decision 73): the field
 * each posts, its words and its muted line, in the order the group shows them, and how each is read
 * aloud after a save. Screens say "Tally", never the name of the AI behind it.
 *
 * Every switch db/ai-switches.ts stores has its row now: "Suggest store names" (Workers AI names, #33)
 * and "Sort new transactions as they arrive" (the Jev run after a sync, #193). Saving this group never
 * changes a switch it doesn't list.
 */
const AI_FEATURES: {
	key: FormSwitch;
	id: string;
	label: string;
	line: string;
	spoken: string;
}[] = [
	{
		key: "names",
		id: "ai-names",
		// P86 A's words and example (decision 80); the other rows take theirs when that change ships.
		label: "Suggest store names",
		line: "Turns bank text like SQ *BLUE BOTTLE COF into Blue Bottle Coffee. You pick the name.",
		spoken: "suggest store names",
	},
	{
		key: "details",
		id: "ai-details",
		label: "Fill in details",
		line: "Adds a note, the kind of spending and who it was for.",
		spoken: "filling in transaction details",
	},
	{
		key: "categories",
		id: "ai-categories",
		label: "Categories and exclusions",
		line: "Picks categories, and leaves out transfers and reimbursements.",
		spoken: "categories and exclusions",
	},
	{
		key: "income",
		id: "ai-income",
		label: "Income",
		line: "Spots paychecks and other money coming in.",
		spoken: "income",
	},
	{
		key: "sortOnArrival",
		id: "ai-sort-on-arrival",
		label: "Sort new transactions as they arrive",
		line: "Sorts them right after each sync, not only overnight.",
		spoken: "sorting new transactions as they arrive",
	},
];

/** What the greyed sorting switch says it needs, in the words of the rows above it. */
const SORT_NEEDS =
	"Needs Fill in details, Categories and exclusions, or Income on.";

/** Sent when the page drew the sorting switch greyed, so Save leaves it as it was. */
const SORT_GREYED = "sortOnArrivalGreyed";

/** Which switches the page drew On, so a save can tell which one the person flipped. */
const DRAWN_ON = "drawnOn";

/** The switch a flip posted, sent with that switch's own request (its hx-vals): the one that takes focus after the save. */
const FLIPPED = "flipped";

/** The DRAWN_ON value for these switches: the keys that are On, separated by spaces. */
const drawnOnOf = (switches: AiSwitches) =>
	AI_FEATURES.flatMap((f) => (switches[f.key] ? [f.key] : [])).join(" ");

/**
 * The AI switches (#606): each switch posts its own change, the page answers with itself, focus back on the switch
 * that changed. The switches share the form's one queue (replace), so a flip cancels the one before it. The form
 * carries no request of its own, so a change is sent once. Save shows only without the script. The form's other
 * fields (the drawn state, the greyed sorting switch) still go with every flip.
 */
function AiSwitchForm({
	switches,
	focus,
}: {
	switches: AiSwitches;
	focus?: keyof AiSwitches;
}) {
	// Sorting is greyed out while Jev isn't asked at all (categories, income and details all off).
	const nothingToSort =
		!switches.categories && !switches.income && !switches.details;

	return (
		<form method="post" action="/settings/ai" data-switches-revert>
			<ul class="mt-3 divide-y divide-rule border-y border-rule">
				{AI_FEATURES.map((f) => (
					<li>
						<Switch
							id={f.id}
							name={f.key}
							label={f.label}
							hint={f.line}
							checked={switches[f.key]}
							disabled={f.key === "sortOnArrival" && nothingToSort}
							note={SORT_NEEDS}
							autofocus={focus === f.key}
							hx-post="/settings/ai"
							hx-trigger="change"
							hx-vals={JSON.stringify({ [FLIPPED]: f.key })}
							hx-sync="closest form:replace"
							hx-target="#ai-suggestions"
							hx-select="#ai-suggestions"
							hx-swap="outerHTML"
						/>
					</li>
				))}
			</ul>
			{nothingToSort && <input type="hidden" name={SORT_GREYED} value="1" />}
			<input type="hidden" name={DRAWN_ON} value={drawnOnOf(switches)} />
			<noscript>
				<div class="mt-4">
					<Button id="ai-save" type="submit">
						Save
					</Button>
				</div>
			</noscript>
		</form>
	);
}

/** AI suggestions (P134 A, #606): its switches, and the In October tally under them. */
function AiPage({
	switches,
	tally,
	focus,
}: {
	switches: AiSwitches;
	tally: AiTallyCounts;
	focus?: keyof AiSwitches;
}) {
	const allOff = AI_FEATURES.every((f) => !switches[f.key]);

	return (
		<section
			id="ai-suggestions"
			aria-labelledby="ai-title"
			class="lg:max-w-3xl"
		>
			<SubpageHead title="AI suggestions" titleId="ai-title" />
			<p class="mt-1 text-muted">
				{allOff
					? "Tally sorts by your rules and choices only."
					: "Off means your rules and choices only. Nothing already decided changes."}
			</p>
			<AiSwitchForm switches={switches} focus={focus} />
			<AiTally tally={tally} switches={switches} />
		</section>
	);
}

/** One Settings page in the app's layout. Each page's title reads "… · Settings · Tally". */
function settingsPage(
	c: Context<App>,
	title: string,
	body: Child,
	status: View["status"] = 200,
) {
	return c.html(
		<Layout
			title={`${title} · Tally`}
			active="settings"
			currentPath={addressOf(c)}
			demo={c.env.DEMO === "true"}
		>
			{body}
		</Layout>,
		status ?? 200,
	);
}

/**
 * The contents page (GET /settings, P134 A): one row for each section, with its live count from what the
 * section holds. Only the counts are read here; each section's page reads its own data.
 */
async function renderContents(c: Context<App>) {
	const db = c.env.DB;
	const timeZone = await householdTimeZone(db);
	const today = todayIn(timeZone);
	const { active } = await settingsCategories(db, today.slice(0, 7));
	const aiSwitches = await readAiSwitches(db);
	const tally = await readAiTally(db, today);
	const bankEmailsOn = await readBankSignInEmails(db);

	const people = await db
		.prepare("SELECT COUNT(*) AS n FROM household_people WHERE id > 1")
		.first<{ n: number }>();

	const waiting = (await suggestionQueue(db, aiSwitches)).length;
	const rules = await merchantRules(db, aiSwitches.names, "");
	const learned = await loadLearnedLines(db);
	const budgeted = active.filter((cat) => cat.budgetCents !== null);

	const places = settingsPlaces({
		categories: {
			count: active.length,
			budgetCents:
				budgeted.length === 0
					? null
					: budgeted.reduce((sum, cat) => sum + (cat.budgetCents ?? 0), 0),
		},
		merchants: rules.total,
		learned: learned.length,
		zone: timeZone,
		bankEmailsOn,
		people: people?.n ?? 0,
		aiOff: AI_FEATURES.filter((f) => !aiSwitches[f.key]).length,
		sorted: tally.sorted,
		month: tally.month,
	});

	return settingsPage(
		c,
		"Settings",
		<SettingsContents waiting={waiting} places={places} />,
	);
}

/**
 * A suggested new category on Settings' categories (decision 120): the one card the Suggestions page draws too. Create
 * files the ticked purchases; No retires the suggestion and asks decision 101's question in the card's place.
 */
function CategorySuggestion({
	suggestion,
	place,
	today,
	existing,
	archived,
	error,
	ticked,
	notes,
}: {
	suggestion: PendingSuggestion;
	/** The card's order in the list: its No sends it back, so the question is drawn where the card was. */
	place: number;
	today: string;
	/** The family's category with this name, when it has one: the Create button adds to it, or restores it. */
	existing?: string;
	archived?: boolean;
	error?: string;
	ticked?: number[];
	notes?: Record<number, string>;
}) {
	const address = `/settings/suggestions/${suggestion.id}`;

	return (
		<div class="mt-3">
			<NewCategoryCard
				name={tidyName(suggestion.name)}
				hidden={<input type="hidden" name="place" value={String(place)} />}
				rows={suggestion.rows.map((row) => ({
					id: row.id,
					name: row.displayName,
					amountCents: row.amountCents,
					date: row.date,
				}))}
				today={today}
				tickName="ids"
				ticked={ticked}
				notes={notes}
				existing={existing}
				archived={archived}
				error={error}
				form={{
					method: "post",
					action: `${address}/create`,
					"data-suggestion": String(suggestion.id),
					"hx-post": `${address}/create`,
					"hx-target": "#categories",
					"hx-select": "#categories",
					"hx-swap": "outerHTML",
				}}
				answers={{
					create: { type: "submit", name: "action", value: "create" },
					no: {
						type: "submit",
						formaction: `${address}/dismiss`,
						"hx-post": `${address}/dismiss`,
						"hx-target": "#categories",
						"hx-select": "#categories",
						"hx-swap": "outerHTML",
					},
				}}
			/>
		</div>
	);
}

/** Categories (#85, #195): the list with its rows, suggestions waiting, Add category and Archived. */
async function renderCategories(c: Context<App>, view: View = {}) {
	const db = c.env.DB;
	// The re-check's line, while a Create's run goes (decision 159).
	const recheck = await runningRecheck(db);
	const timeZone = view.timeZone ?? (await householdTimeZone(db));
	const today = view.today ?? todayIn(timeZone);
	const { active, archived } = await settingsCategories(db, today.slice(0, 7));

	const { suggestions: categorySuggestions, more: moreSuggestions } =
		await pendingSuggestionPage(db);

	const adding = view.open === "new";

	const cards = categorySuggestions.map((suggestion, place) => {
		// A suggestion whose name a category already has is added to it, or restores it when archived, not made again
		// (decisions 101, 110): Add to the active category with the suggested name, or Restore the archived one.
		const named = [...active, ...archived].find((cat) =>
			sameName(cat.name, tidyName(suggestion.name)),
		);

		return (
			<CategorySuggestion
				place={place}
				today={today}
				suggestion={suggestion}
				existing={named?.name}
				archived={named !== undefined && archived.includes(named)}
				error={
					view.suggestionValues?.id === suggestion.id
						? view.suggestionError
						: undefined
				}
				ticked={
					view.suggestionValues?.id === suggestion.id
						? view.suggestionValues.ticked
						: undefined
				}
				notes={
					view.suggestionValues?.id === suggestion.id
						? view.suggestionValues.notes
						: undefined
				}
			/>
		);
	});

	// The question after a No (decision 101), in the card's place: its Yes and Not now post to the same address. The
	// No sends its card's place, so the question is drawn where the card was; splice puts it last past the end.
	if (view.ask)
		cards.splice(
			view.ask.place ?? cards.length,
			0,
			<div class="mt-3">
				<AskFirst
					action={`/settings/suggestions/${view.ask.suggestionId}/dismiss`}
					target="#categories"
					kind="new_category"
					id={view.ask.id}
					name={view.ask.name}
					stores={view.ask.stores}
					focus
				/>
			</div>,
		);

	return settingsPage(
		c,
		"Categories · Settings",
		<section
			id="categories"
			aria-labelledby="categories-title"
			class="lg:max-w-3xl"
		>
			<SubpageHead title="Categories" titleId="categories-title" />
			<RecheckLine run={recheck} page="categories" />
			{view.listError && (
				<p role="alert" class="mt-3 text-sm text-over">
					{view.listError}
				</p>
			)}
			<div class="mt-3 border-t border-rule">
				{active.length === 0 && (
					<EmptyState
						kind="done"
						sentence="No active categories."
						hint={
							archived.length > 0
								? "Add one below, or restore an archived category."
								: "Add one below."
						}
					/>
				)}
				{active.map((category, i) => (
					<CategoryRow
						category={category}
						first={i === 0}
						last={i === active.length - 1}
						open={view.open === category.id}
						focus={view.focus === category.id && !view.errors}
						values={view.values}
						errors={view.errors}
						saved={
							view.saved?.kind === "category" && view.saved.id === category.id
								? "toast"
								: undefined
						}
					/>
				))}
				{cards}
				{moreSuggestions > 0 && (
					<p class="py-2 text-sm text-muted">
						{moreSuggestions} more suggestions will show once you decide these.
					</p>
				)}
				<AddCategoryRow
					open={adding}
					values={view.values}
					errors={view.errors}
				/>
				{archived.length > 0 && (
					<details
						class="group border-b border-rule"
						open={Boolean(view.restoreError)}
					>
						<summary class={summaryClass} autofocus={view.focus === "archived"}>
							<span class="min-w-0 flex-1">Archived ({archived.length})</span>
							{chevron}
						</summary>
						{view.restoreError && (
							<p role="alert" class="pb-2 text-sm text-over">
								{view.restoreError}
							</p>
						)}
						<ul class="pb-3">
							{archived.map((a) => (
								<li class="flex min-h-11 items-center gap-4">
									<CategoryIcon icon={a.icon} color={a.color} />
									<span class="text-lg text-muted">{a.name}</span>
									<form
										id={`cat-${a.id}-restore-form`}
										class="ml-auto"
										{...swap(
											`/settings/categories/${a.id}/restore`,
											`cat-${a.id}-restore`,
										)}
									>
										<Button
											id={`cat-${a.id}-restore`}
											type="submit"
											kind="text"
											busyLabel="Restoring…"
										>
											Restore
										</Button>
									</form>
								</li>
							))}
						</ul>
					</details>
				)}
			</div>
		</section>,
		view.status,
	);
}

/** Tally's rules (#214, #195, decision 101): the Always list A to Z, and the Never suggest lines. */
async function renderRules(c: Context<App>, view: View = {}) {
	const db = c.env.DB;
	const today = view.today ?? todayIn(await householdTimeZone(db));
	const aiSwitches = await readAiSwitches(db);

	const rulesSearch =
		view.rulesSearch ??
		new URL(c.req.url).searchParams.get("rules_search") ??
		"";

	const ruleData = await merchantRules(db, aiSwitches.names, rulesSearch);
	const neverRules = await neverSuggestRules(db);

	return settingsPage(
		c,
		"Tally's rules · Settings",
		<MerchantRules
			head={
				<SubpageHead title="Tally's rules" titleId="merchant-rules-title" />
			}
			rules={ruleData.rules.map((rule) => ({
				...rule,
				archived: rule.archived === 1,
			}))}
			total={ruleData.total}
			focusRuleIndex={view.focusRuleIndex}
			focusHeading={view.focusMerchantHeading}
			error={view.merchantRuleError}
			neverRules={neverRules}
			neverFocus={view.focusNever}
			today={today}
			search={
				ruleData.total > MERCHANT_RULE_SEARCH_THRESHOLD ? rulesSearch : ""
			}
		/>,
		view.status,
	);
}

/** What Tally has learned (decisions 156 and 162): one line per text a person's answers taught, each with Forget. */
async function renderLearned(c: Context<App>, view: View = {}) {
	const lines = await loadLearnedLines(c.env.DB);
	const categories = await learnedCategoryChoices(c.env.DB);

	return settingsPage(
		c,
		"What Tally has learned · Settings",
		<LearnedPage
			lines={lines}
			error={view.learnedError}
			change={view.learnedChange}
			categories={categories}
		/>,
		view.status,
	);
}

/** Household (decisions 67, 72, 82): the time zone and the bank sign-in emails switch with its recipients. */
async function renderHousehold(c: Context<App>, view: View = {}) {
	const db = c.env.DB;
	const timeZone = view.timeZone ?? (await householdTimeZone(db));
	const bankEmailsOn = await readBankSignInEmails(db);
	const members = await reconnectRecipients(db);

	return settingsPage(
		c,
		"Household · Settings",
		<section
			id="household"
			aria-labelledby="household-title"
			class="lg:max-w-3xl"
		>
			<SubpageHead title="Household" titleId="household-title" />
			<div class="mt-3 border-t border-rule">
				<TimeZoneRow
					zone={timeZone}
					error={view.zoneError}
					focus={view.focus === "zone"}
					saved={view.saved?.kind === "zone" ? "toast" : undefined}
				/>
				<BankSignInEmails
					on={bankEmailsOn}
					recipients={members.results.map(({ email }) => email)}
					error={view.bankSignInEmailError}
					open={Boolean(view.bankSignInEmailsOpen)}
					focus={bankSignInEmailFocus(view.focus)}
					focusEmail={view.bankSignInEmailFocusEmail}
				/>
			</div>
		</section>,
		view.status,
	);
}

/** People (decision 81): the household's names, Everyone first. */
async function renderPeople(c: Context<App>, view: View = {}) {
	const people = await c.env.DB.prepare(
		"SELECT id, name FROM household_people ORDER BY id",
	).all<{ id: number; name: string }>();

	return settingsPage(
		c,
		"People · Settings",
		<HouseholdPeople
			head={
				<SubpageHead
					title="People"
					titleId="people-title"
					focus={view.peopleFocus}
				/>
			}
			people={people.results}
			openId={view.peopleOpen}
			addOpen={view.peopleAddOpen}
			error={view.peopleError}
			errorPersonId={view.peopleErrorPersonId}
			value={view.peopleValue}
			saved={
				view.saved?.kind === "person"
					? { id: view.saved.id, mark: "toast" }
					: undefined
			}
		/>,
		view.status,
	);
}

/** AI suggestions (decision 73, P41 B): the switches and the month's tally. */
async function renderAi(c: Context<App>, view: View = {}) {
	const db = c.env.DB;
	const today = view.today ?? todayIn(await householdTimeZone(db));
	const switches = await readAiSwitches(db);
	const tally = await readAiTally(db, today);

	return settingsPage(
		c,
		"AI suggestions · Settings",
		<AiPage switches={switches} tally={tally} focus={view.aiFocus} />,
		view.status,
	);
}

/** Your data (spec §8.1): the two downloads. Nothing on it posts. */
function renderData(c: Context<App>) {
	return settingsPage(
		c,
		"Your data · Settings",
		<section
			id="your-data"
			aria-labelledby="your-data-title"
			class="lg:max-w-3xl"
		>
			<SubpageHead title="Your data" titleId="your-data-title" />
			<p class="mt-1 text-muted">
				Everything Tally has stored, to keep or open elsewhere. Bank logins are
				never included.
			</p>
			<div class="mt-4 flex flex-col items-start gap-3">
				<Button kind="secondary" href="/settings/export/transactions.csv">
					Download transactions (CSV)
				</Button>
				<Button kind="secondary" href="/settings/export/tally.json">
					Download everything (JSON)
				</Button>
			</div>
		</section>,
	);
}

/** The page a section draws, with the view its request needs. Each save answers with the page it lives on. */
function renderPage(c: Context<App>, page: Page, view: View = {}) {
	switch (page) {
		case "categories":
			return renderCategories(c, view);
		case "rules":
			return renderRules(c, view);
		case "learned":
			return renderLearned(c, view);
		case "household":
			return renderHousehold(c, view);
		case "people":
			return renderPeople(c, view);
		case "ai":
			return renderAi(c, view);
		case "data":
			return renderData(c);
	}
}

/** The categories page again, for an Undo answer of the re-check (decision 160): the page the toast was shown on. */
export function categoriesAgain(c: Context<App>) {
	return renderPage(c, "categories");
}

/** Settings' rules, with the Always search kept in the address (a Remove without script returns here). */
function rulesAddress(search: string): string {
	return `/settings/rules${search ? `?rules_search=${encodeURIComponent(search)}` : ""}`;
}

settings.post("/settings/merchant-rules/remove", async (c) => {
	const form = await c.req.formData();
	const merchantKey = String(form.get("merchant") ?? "");
	const search = String(form.get("rules_search") ?? "");

	if (!merchantKey) {
		const message = "Choose a merchant to remove.";

		if (c.req.header("HX-Request"))
			c.header("HX-Trigger", hxTrigger({ announce: message }));

		return renderPage(c, "rules", {
			rulesSearch: search,
			merchantRuleError: message,
			status: 400,
		});
	}

	const switches = await readAiSwitches(c.env.DB);
	const before = await merchantRules(c.env.DB, switches.names, search, true);
	const focusRules = before;

	const removed = await runWith(
		c.env.DB,
		decideSetting(
			removeAlwaysRule,
			{ merchantKey },
			(db) => alwaysRuleFacts(db, merchantKey),
			removeAlwaysRuleStatements,
		).pipe(
			Effect.map(({ decided }) => Option.getOrNull(decided)?.merchant ?? null),
		),
	);

	const view = { rulesSearch: search };

	if (!removed) {
		if (c.req.header("HX-Request"))
			c.header(
				"HX-Trigger",
				hxTrigger({ announce: "Merchant rules list updated." }),
			);

		return renderPage(c, "rules", view);
	}

	const message = `Removed the Always rule for ${removed}`;

	if (c.req.header("HX-Request")) {
		c.header(
			"HX-Trigger",
			hxTrigger({
				toast: { message, type: "success" },
				announce: `Removed ${removed}. ${Math.max(0, before.total - 1)} merchant${before.total === 2 ? "" : "s"} left.`,
			}),
		);

		return renderPage(c, "rules", {
			...view,
			...ruleFocus(focusRules.rules, merchantKey),
		});
	}

	return c.redirect(rulesAddress(search), 303);
});

// Remove takes one "Never suggest" line away and says so; the suggestion may come back as a fresh guess.
// The store's linked lines go with it (decision 101). Focus goes to the line that took the clicked line's place,
// counting only the lines left above it, or to the heading when none is left.
/** The Remove rule for a line as Settings draws it. */
const removeNeverSuggest = removeNeverSuggestLine<NeverSuggestRule>();

settings.post("/settings/never-suggest/remove", async (c) => {
	const form = await c.req.formData();
	// A refused id is 0, which no line has: the rule finds no line, as for a number that is no line's.
	const id = rowIdOrZero(textOf(form.get("id")));
	const merchantKey = String(form.get("merchant_key") ?? "");
	const kind = String(form.get("kind") ?? "");
	const search = String(form.get("rules_search") ?? "");
	const lines = await neverSuggestRules(c.env.DB);

	// A number that is no line's finds no line, so the rule has nothing to do, as for a line already gone.
	const removed = await runWith(
		c.env.DB,
		decideSetting(
			removeNeverSuggest,
			{ id },
			(db) => neverSuggestLineFacts(db, { id, merchantKey, kind }),
			removeNeverSuggestStatements,
		).pipe(
			Effect.map(({ decided }) => {
				const write = Option.getOrNull(decided);

				return write && { rule: write.line };
			}),
		),
	);

	if (!removed) {
		// A line that is already gone: a plain form goes back to the rules, as a Remove that worked does.
		if (!c.req.header("HX-Request"))
			return c.redirect(rulesAddress(search), 303);
		c.header(
			"HX-Trigger",
			hxTrigger({ announce: "Tally's rules list updated." }),
		);

		return renderPage(c, "rules", {
			rulesSearch: search,
			focusNever: lines.length === 0 ? { heading: true } : { index: 0 },
		});
	}

	const message = "Removed. Tally can suggest that again.";

	if (c.req.header("HX-Request")) {
		c.header(
			"HX-Trigger",
			hxTrigger({
				toast: { message, type: "success" },
				announce: `${message} ${neverSuggestRuleLine(removed.rule)} is gone.`,
			}),
		);
		const after = await neverSuggestRules(c.env.DB);
		const keep = new Set(after.map((line) => line.id));
		const index = lines.findIndex((line) => line.id === removed.rule.id);

		const above = lines
			.slice(0, Math.max(index, 0))
			.filter((line) => keep.has(line.id)).length;

		return renderPage(c, "rules", {
			rulesSearch: search,
			focusNever:
				after.length === 0
					? { heading: true }
					: { index: Math.min(above, after.length - 1) },
		});
	}

	return c.redirect(rulesAddress(search), 303);
});

// Forget takes one learned line away and says so, with a ten-second Undo (decision 162). The text is posted in the
// body, never the address. A text with no line now (a stale form) changes nothing and says the normal thing.
settings.post("/settings/learned/forget", async (c) => {
	const form = await c.req.formData();
	const text = String(form.get("text") ?? "");

	if (text === "") {
		const message = "Choose a line to forget.";

		if (c.req.header("HX-Request"))
			c.header("HX-Trigger", hxTrigger({ announce: message }));

		return renderPage(c, "learned", { learnedError: message, status: 400 });
	}

	const line = (await loadLearnedLines(c.env.DB)).find(
		(learned) => learned.cleanedText === text,
	);

	const name = line ? `${line.name} → ${line.categoryName}` : displayName(text);
	const message = `Forgot ${name}. Tally goes back to guessing.`;
	// The time of the Forget is taken here and handed to the rule (decision 195): the Undo's ten seconds count from it.
	const forgottenAt = Date.now();

	const id = await runWith(
		c.env.DB,
		decideSetting(
			forgetLine,
			{ text, now: forgottenAt },
			async (db) => ({
				learned: line !== undefined,
				version: await textVersion(db, text),
			}),
			forgetStatements,
		).pipe(
			// The Forget's own statement answers with its row's number, which the Undo names.
			// SAFETY: that statement, the second of the batch, ends in RETURNING id, so its first row has an id.
			Effect.map(
				({ saved }) =>
					(saved?.[1]?.results[0] as { id: number } | undefined)?.id ?? 0,
			),
		),
	);

	if (!c.req.header("HX-Request")) return c.redirect("/settings/learned", 303);
	// The Undo's time is what is left of the ten seconds since the Forget's stored time, so the button never outlives the window.
	const left = id > 0 ? forgetUndoLeftMs(forgottenAt, Date.now()) : 0;

	const toast =
		left >= FORGET_UNDO_MIN_MS
			? {
					message,
					type: "success",
					undo: String(id),
					undoExpiresInMs: left,
					undoAction: "/settings/learned/undo",
				}
			: { message, type: "success" };

	c.header("HX-Trigger", hxTrigger({ toast, announce: message }));

	return renderPage(c, "learned");
});

// Undo of a Forget: the line comes back if the Undo is within its ten seconds. Its answer ends the Undo's toast.
settings.post("/settings/learned/undo", async (c) => {
	const form = await c.req.formData();
	// The token as posted, echoed as it was; a file part is no token, so it is the empty text.
	const token = textOf(form.get("token"));
	// A token that is no Forget's number finds no row, so the rule refuses it as it refuses one already undone.
	const id = rowIdOrZero(token);

	const refusal = await runWith(
		c.env.DB,
		decideSetting(
			undoForget,
			{ id, now: Date.now() },
			(db) => undoForgetFacts(db, id),
			undoForgetStatements,
		).pipe(
			Effect.as(null),
			Effect.catch((refused) => Effect.succeed(refused)),
		),
	);

	if (!c.req.header("HX-Request")) return c.redirect("/settings/learned", 303);

	const toast = refusal
		? { message: refusal.say, type: "error", undoDone: token }
		: {
				message: "Forget undone. Tally has that line back.",
				type: "success",
				undoDone: token,
			};

	c.header("HX-Trigger", hxTrigger({ toast, announce: toast.message }));

	return renderPage(c, "learned");
});

// Change on a learned line (decision 163): a rule on the cleaned bank text, made in place from the line. A text with no
// line now (a stale form) and a known-vague text, which no rule can cover, are refused for the page. A category that is
// unknown or archived is refused beside its own line. Otherwise the rule is saved and applied at once to what nothing has
// filled, and a toast says so. The rule never changes a merchant rule.
settings.post("/settings/learned/change", async (c) => {
	const form = await c.req.formData();
	const text = String(form.get("text") ?? "");
	const category = readAtEdge(CategoryId, textOf(form.get("category")));
	const htmx = Boolean(c.req.header("HX-Request"));

	const line =
		text === ""
			? undefined
			: (await loadLearnedLines(c.env.DB)).find(
					(learned) => learned.cleanedText === text,
				);

	const refuse = (message: string) => {
		if (htmx) c.header("HX-Trigger", hxTrigger({ announce: message }));

		return renderPage(c, "learned", { learnedError: message, status: 400 });
	};

	// A category that is no category is 0, which no category has: the rule refuses it beside its line.
	const chosen = category.ok ? category.value : 0;

	// The rule decides; the rule and its immediate apply are one batch (review of #838), so a failure leaves no rule,
	// and says so.
	let answer: { saved: ChangeLineWrite } | { refused: Refusal };

	try {
		answer = await runWith(
			c.env.DB,
			decideSetting(
				changeLine,
				{ text, categoryId: chosen },
				(db) =>
					changeLineFacts(
						db,
						text,
						chosen,
						line ? { name: line.name, vague: line.vague } : null,
					),
				changeLineStatements,
			).pipe(
				Effect.map(({ decided }) => ({ saved: Option.getOrThrow(decided) })),
				Effect.catch((refused) => Effect.succeed({ refused })),
			),
		);
	} catch {
		const message =
			"Tally couldn't save that rule, so nothing changed. Try again.";

		if (htmx) c.header("HX-Trigger", hxTrigger({ announce: message }));

		return renderPage(c, "learned", { learnedError: message, status: 503 });
	}

	if ("refused" in answer) {
		const { refused } = answer;

		// A category that is unknown or archived is refused beside its own line.
		if (Predicate.isTagged(refused, "NoCategoryChosen")) {
			if (htmx) c.header("HX-Trigger", hxTrigger({ announce: refused.say }));

			return renderPage(c, "learned", {
				learnedChange: { cleanedText: text, error: refused.say },
				status: 400,
			});
		}

		// The page names the line that is too vague for a rule.
		return refuse(
			Predicate.isTagged(refused, "LineTooVague") && line
				? `${line.name} covers more than one kind of purchase, so a rule can't be made for it.`
				: refused.say,
		);
	}

	if (!htmx) return c.redirect("/settings/learned", 303);
	const message = `${answer.saved.lineName} now goes to ${answer.saved.categoryName} every time.`;
	c.header(
		"HX-Trigger",
		hxTrigger({ toast: { message, type: "success" }, announce: message }),
	);

	return renderPage(c, "learned");
});

/** The categories page with the changed-suggestion list, at 404: a suggestion that is gone, or an id that is no row id. */
const changedSuggestion = (c: Context<App>) =>
	renderPage(c, "categories", {
		listError: CHANGED_SUGGESTION,
		status: 404,
	});

settings.post("/settings/suggestions/:id{[0-9]+}/create", async (c) => {
	const id = rowIdOf(c.req.param("id"));

	// An id that is no row id is no suggestion: the changed list answers, before anything is read or written.
	if (id === undefined) return changedSuggestion(c);
	const form = await c.req.formData();

	const ids = rowIdsOf(form.getAll("ids"));
	const shown = rowIdsOf(form.getAll("shown"));

	const notes = Object.fromEntries(
		shown.map((tx) => [tx, String(form.get(`note_${tx}`) ?? "")]),
	);

	const result = await createFromSuggestion(
		c.env.DB,
		id,
		{ ticked: ids, shown, notes },
		actor(c),
	);

	if (!result.ok) {
		const current = await renderPage(
			c,
			"categories",
			result.reason === "gone"
				? {
						listError: CHANGED_SUGGESTION,
						status: 404,
					}
				: {
						suggestionError: result.error,
						suggestionValues: { id, ticked: ids, notes },
						status: 422,
					},
		);

		return current;
	}

	await askAgainLeftOut(c.env, result.leftOut, (work) =>
		c.executionCtx.waitUntil(work),
	);
	// Only a new category starts the re-check (decision 157): an Add to or a Restore changes nothing the run would sort.
	const created = !result.attached && !result.restored;
	const [filedId] = result.filed;

	const rechecking =
		created && filedId !== undefined
			? await startResortFor(c.env, c.env.DB, {
					filedId,
					excludeIds: [...result.leftOut, ...result.filed],
				})
			: null;

	const count = result.moved;
	const transactions = `${count} transaction${count === 1 ? "" : "s"}`;

	const message = result.restored
		? `Restored ${result.name} with ${transactions}`
		: result.attached
			? `Added ${transactions} to ${result.name}`
			: `Created ${result.name} with ${transactions}`;

	const left = leftOutSentence(result.leftOut.length);
	const started = rechecking ? ` ${STARTED_ANNOUNCEMENT}` : "";

	return done(c, message, `${message}.${left ? ` ${left}` : ""}${started}`, {
		page: "categories",
	});
});

/**
 * The question after a No, answered where it was asked (decision 101): Yes writes one "Never suggest" line for each
 * store it asked about, and Not now writes none. The answer must still be this suggestion's question, or nothing is written.
 */
async function answerQuestion(c: Context<App>, id: number, form: FormData) {
	const answer = form.get("answer")?.toString() ?? "";

	// Each store once, however often the form repeats it (#440).
	const stores = [
		...new Set(
			form
				.getAll("store")
				.map((store) => store.toString())
				.filter(
					(store) => store.length > 0 && store.length <= MERCHANT_KEY_MAX,
				),
		),
	];

	const stale = () => changedSuggestion(c);

	if (
		form.get("id")?.toString() !== `new-${id}` ||
		form.get("kind")?.toString() !== "new_category" ||
		stores.length === 0
	)
		return stale();

	if (answer === "ask_not_now")
		return done(c, "Kept it as it is.", "Kept it as it is.", {
			page: "categories",
		});

	if (answer !== "ask_yes") return stale();

	const labels = await writeNeverSuggest(c.env.DB, {
		kind: "new_category",
		itemId: id,
		stores,
		today: await householdToday(c.env.DB),
	});

	if (labels === null) return stale();
	const message = neverSuggestedMessage("new_category", labels);

	return done(c, message, message, { page: "categories" });
}

settings.post("/settings/suggestions/:id{[0-9]+}/dismiss", async (c) => {
	const db = c.env.DB;
	const id = rowIdOf(c.req.param("id"));
	const form = await c.req.formData();

	// The question's own answer, posted from the question drawn in the card's place (decision 101). A refused id is 0 here,
	// as Number() gave 0 before; answerQuestion's own checks refuse it, with the answers it always gave.
	if (form.get("answer")) return answerQuestion(c, id ?? 0, form);

	// A refused id is no suggestion: the changed list answers, before anything is written.
	if (id === undefined) return changedSuggestion(c);

	// The No retires the suggestion, and the question asks in the card's place (decisions 101, 120).
	const result = await runWith(
		db,
		decideDismiss(dismissNewCategory, { suggestionId: id }).pipe(
			Effect.catchTag("SuggestionChanged", () => Effect.succeed(null)),
		),
	);

	if (!result) return changedSuggestion(c);
	const name = tidyName(result.name);
	const stores = await askedStores(db, id);
	// The No sends its card's place, so the question is drawn where the card was. A missing or non-numeric place
	// leaves the question after every card.
	const placed = readAtEdge(CardPlace, textOf(form.get("place")));
	const place = placed.ok ? placed.value : undefined;

	if (stores.length > 0)
		return renderPage(c, "categories", {
			ask: { suggestionId: id, id: `new-${id}`, name, stores, place },
		});
	// Nothing is left to ask about, so the toast says only what the No did: the name is never suggested again.
	const message = `Tally won't suggest ${name} again.`;

	return done(c, message, message, { page: "categories" });
});

/** After a change: htmx gets the page the change lives on, with a toast and announcement; a plain browser goes there. */
function done(c: Context<App>, toast: string, announce: string, view: Done) {
	if (!c.req.header("HX-Request"))
		return c.redirect(`/settings/${view.page}`, 303);
	c.header(
		"HX-Trigger",
		hxTrigger({ toast: { message: toast, type: "success" }, announce }),
	);

	return renderPage(c, view.page, view);
}

/** The form again, open, with what was typed and why it wasn't saved. */
function retry(
	c: Context<App>,
	open: number | "new",
	form: FormData,
	errors: CategoryErrors,
) {
	return renderPage(c, "categories", {
		open,
		values: { name: String(form.get("name") ?? "") },
		errors,
		status: 422,
	});
}

/** The database refused a name that differs only in capitals: someone saved it a moment earlier. */
export const nameTaken = (cause: unknown) => isUniqueViolation(cause);

/**
 * The category was archived, restored or never existed: another screen got there first. The
 * current list comes back with a message, so the section is never swapped for a bare 404.
 */
const gone = (c: Context<App>) =>
	renderPage(c, "categories", {
		listError:
			"That category was changed somewhere else. Here's the current list.",
		status: 404,
	});

const idOf = (c: Context<App>) => Number(c.req.param("id"));

async function find(c: Context<App>) {
	const all = await categoryNames(c.env.DB);

	return { all, category: all.find((x) => x.id === idOf(c)) };
}

// More → Settings (spec §8): the contents page, then one page for each section (decision 120). Budgets are set on
// Home (decision 38). Categories: ?open=<id> opens that category's row, so a row can be linked to (and screenshotted);
// ?focus=<id> puts focus on that row after Cancel. Household: ?focus=zone focuses the Time zone row. People:
// ?peopleFocus=1 focuses the page's title after Cancel.
const numberParam = (c: Context<App>, key: string) => {
	const read = readAtEdge(CategoryId, c.req.query(key));

	return read.ok ? read.value : undefined;
};

settings.get("/settings", (c) => renderContents(c));

settings.get("/settings/categories", (c) =>
	renderCategories(c, {
		open: numberParam(c, "open"),
		focus: numberParam(c, "focus"),
	}),
);

settings.get("/settings/rules", (c) => renderRules(c));

settings.get("/settings/learned", (c) => renderLearned(c));

settings.get("/settings/household", (c) =>
	renderHousehold(c, {
		focus: c.req.query("focus") === "zone" ? "zone" : undefined,
	}),
);

settings.get("/settings/people", (c) =>
	renderPeople(c, { peopleFocus: c.req.query("peopleFocus") === "1" }),
);

settings.get("/settings/ai", (c) => renderAi(c));

settings.get("/settings/data", (c) => renderData(c));

settings.get("/settings/export/transactions.csv", async (c) => {
	c.header("Content-Type", "text/csv; charset=utf-8");
	c.header("Cache-Control", "no-store");
	c.header(
		"Content-Disposition",
		`attachment; filename="tally-transactions-${await householdToday(c.env.DB)}.csv"`,
	);

	return c.body(await transactionsCsv(c.env.DB));
});

settings.get("/settings/export/tally.json", async (c) => {
	c.header("Cache-Control", "no-store");
	c.header(
		"Content-Disposition",
		`attachment; filename="tally-${await householdToday(c.env.DB)}.json"`,
	);

	return c.json(await tallyExport(c.env.DB));
});

// A switch that's on posts "on" and one that's off posts nothing, so a field left out is off. The form still
// posts the whole group, but a save writes only the switches that differ from what the page drew On (DRAWN_ON),
// plus the one just flipped (FLIPPED), so another tab's change to a different switch is never undone. The
// sorting switch is greyed out while Jev isn't asked at all (categories and income both off), and a greyed
// switch posts nothing, so Save doesn't write it at all and it stays as it was saved (spec §8.6, decision 79).
// Whether it was greyed comes from the form the person saw (a hidden field), not from what's saved now, since
// another tab may have changed the switches since the page was drawn.
settings.post("/settings/ai", async (c) => {
	const form = await c.req.formData();

	// SAFETY: the keys are AI_FEATURES' own keys, so the record holds exactly the switches a Partial<AiSwitches> names.
	const next = Object.fromEntries(
		AI_FEATURES.map((f) => [f.key, form.get(f.key) === "on"]),
	) as Partial<AiSwitches>;

	if (form.get(SORT_GREYED) === "1") delete next.sortOnArrival;
	const waitingBefore = (await suggestionQueue(c.env.DB)).length;
	const before = await readAiSwitches(c.env.DB);
	// The page's baseline, shared by the save and the focus below. A page drawn before DRAWN_ON existed is compared
	// with what was saved before this save.
	const drawn = String(form.get(DRAWN_ON) ?? drawnOnOf(before)).split(" ");
	const posted = AI_FEATURES.find((f) => f.key === form.get(FLIPPED))?.key;

	await runWith(
		c.env.DB,
		decideSetting(
			saveAiSwitchesRule,
			{
				posted: next,
				drawnOn: drawn.flatMap((name) => switchNamed(name) ?? []),
				flipped: posted,
			},
			aiSwitchesFacts,
			aiSwitchesStatements,
		),
	);
	const now = await readAiSwitches(c.env.DB);

	// The switch that was flipped keeps focus after the save (#606). A flip posts its own key (FLIPPED, from its own
	// request). A plain Save, with no script, posts none, so it's the one that differs from what the page drew On
	// (DRAWN_ON): another tab that saved the same value doesn't move it.
	const flipped =
		posted ??
		AI_FEATURES.find(
			(f) => f.key in next && next[f.key] !== drawn.includes(f.key),
		)?.key;

	const waitingAfter = (await suggestionQueue(c.env.DB, now)).length;

	const states = AI_FEATURES.map(
		(f) => `${f.spoken} ${now[f.key] ? "on" : "off"}`,
	).join(", ");

	const spoken = states.charAt(0).toUpperCase() + states.slice(1);

	// The Band above Categories changes with the switches, so a change in what it says is announced too.
	const band =
		waitingAfter === waitingBefore
			? ""
			: waitingAfter === 0
				? " Nothing to check."
				: ` ${waitingAfter} ${waitingAfter === 1 ? "suggestion" : "suggestions"} to check.`;

	return done(
		c,
		"Saved AI suggestions",
		`Saved AI suggestions. ${spoken}.${band}`,
		{ page: "ai", aiFocus: flipped },
	);
});

settings.post("/settings/bank-sign-in-emails", async (c) => {
	const form = await c.req.formData();

	// A Remove button posts its address as `remove`; a Remove never changes the switch.
	if (form.has("remove"))
		return removeBankSignInEmail(c, textOf(form.get("remove")));
	const on = form.get("enabled") === "on";
	await runWith(
		c.env.DB,
		decideSetting(
			saveBankSignInEmailsRule,
			{ on },
			noFacts,
			bankSignInEmailsStatements,
		),
	);

	return done(
		c,
		"Saved bank sign-in emails",
		`Bank sign-in emails ${on ? "On" : "Off"}.`,
		{
			page: "household",
			focus: "bank-sign-in-email-switch",
			bankSignInEmailsOpen: true,
		},
	);
});

async function removeBankSignInEmail(c: Context<App>, posted: string) {
	const read = readAtEdge(SignInAddress, posted);

	if (!read.ok) return bankSignInEmailError(c, read.say, 400);
	const email = read.value;

	const refused = await runWith(
		c.env.DB,
		decideSetting(
			removeSignInAddress,
			{ email, now: Date.now() },
			(db) => addressFacts(db, email),
			removeAddressStatements,
		).pipe(
			Effect.as(null),
			Effect.catchTag("AddressNotFound", (refusal) => Effect.succeed(refusal)),
		),
	);

	if (refused) return bankSignInEmailError(c, refused.say, 404);

	// The list is in address order: the address that takes the removed row's place is the next one, else the one before it.
	const remaining = (await reconnectRecipients(c.env.DB)).results.map(
		({ email: address }) => address,
	);

	const before = remaining.filter((address) => address < email).length;
	const focusEmail = remaining[before] ?? remaining[before - 1];

	return done(
		c,
		"Removed address",
		"Removed this sign-in address from bank sign-in emails.",
		{
			page: "household",
			focus: focusEmail
				? "bank-sign-in-email-remove"
				: "bank-sign-in-email-summary",
			bankSignInEmailsOpen: true,
			bankSignInEmailFocusEmail: focusEmail,
		},
	);
}

function bankSignInEmailError(
	c: Context<App>,
	message: string,
	status: 400 | 404,
) {
	c.header(
		"HX-Trigger",
		hxTrigger({ toast: { message, type: "error" }, announce: message }),
	);

	// The Remove that was pressed is gone from the swap, so the addresses stay open and focus goes to their summary.
	return renderPage(c, "household", {
		bankSignInEmailError: message,
		status,
		bankSignInEmailsOpen: true,
		focus: "bank-sign-in-email-summary",
	});
}

/** Which control of the bank sign-in emails block takes focus after a swap, from the page's focus. */
function bankSignInEmailFocus(focus: View["focus"]) {
	if (focus === "bank-sign-in-email-switch") return "switch";

	if (focus === "bank-sign-in-email-summary") return "summary";

	if (focus === "bank-sign-in-email-remove") return "remove";

	return undefined;
}

settings.post("/settings/people", async (c) => {
	const form = await c.req.formData();

	const action = form.has("remove")
		? "remove"
		: String(form.get("action") ?? "");

	const nameValue = String(form.get("name") ?? "");
	// A refused id is 0: no row opens and nothing is removed or renamed, as a NaN gave before.
	const id = rowIdOrZero(textOf(form.get("person_id")));

	if (action === "remove") {
		if (id <= 1) return c.text("Not found", 404);

		const removed = await runWith(
			c.env.DB,
			decideSetting(
				removePerson,
				{ id, who: actor(c) },
				(db) => personFacts(db, id),
				removePersonStatements,
			).pipe(
				// The statement that clears the person's purchases is the batch's second, after the guard.
				Effect.map(({ decided, saved }) => ({
					name: Option.getOrThrow(decided).name,
					count: saved?.[1]?.meta.changes ?? 0,
				})),
				Effect.catchTag("PersonGone", () => Effect.succeed(null)),
			),
		);

		if (!removed) return c.notFound();
		const person = { name: removed.name };
		const { count } = removed;

		return done(
			c,
			`Removed ${person.name}`,
			`Removed ${person.name}. ${count} ${count === 1 ? "purchase" : "purchases"} for ${person.name} now say no one.`,
			{ page: "people", peopleAddOpen: true, peopleFocus: true },
		);
	}

	const typed = readAtEdge(PersonName, nameValue);

	if (!typed.ok)
		return renderPage(c, "people", {
			peopleOpen: action === "rename" ? id : undefined,
			peopleErrorPersonId: action === "rename" ? id : undefined,
			peopleAddOpen: action !== "rename",
			peopleError: typed.say,
			peopleValue: nameValue,
			status: 422,
		});
	const name = typed.value;

	if (action === "add") {
		const result = await runWith(
			c.env.DB,
			decideSetting(
				addPerson,
				{ name },
				noFacts,
				addPersonStatements,
				personNameTaken,
			).pipe(
				Effect.map(({ saved }) => ({
					id: Number(saved?.[0]?.meta.last_row_id),
				})),
				Effect.catchTag("PersonNameTaken", (refusal) =>
					Effect.succeed({ refused: refusal.say }),
				),
			),
		);

		if ("refused" in result)
			return renderPage(c, "people", {
				peopleAddOpen: true,
				peopleError: result.refused,
				peopleValue: nameValue,
				status: 422,
			});
		const added = result.id;

		return done(c, `Added ${name}`, `Added ${name} to your household.`, {
			page: "people",
			peopleAddOpen: true,
			peopleFocus: true,
			saved: { kind: "person", id: added },
		});
	}

	if (action === "rename" && id > 1) {
		const refused = await runWith(
			c.env.DB,
			decideSetting(
				renamePerson,
				{ id, name },
				(db) => personFacts(db, id),
				renamePersonStatements,
				personNameTaken,
			).pipe(
				Effect.as(null),
				Effect.catch((refusal) => Effect.succeed(refusal)),
			),
		);

		if (refused && Predicate.isTagged(refused, "PersonGone"))
			return c.notFound();

		if (refused)
			return renderPage(c, "people", {
				peopleOpen: id,
				peopleErrorPersonId: id,
				peopleError: refused.say,
				peopleValue: nameValue,
				status: 422,
			});

		return done(c, `Renamed to ${name}`, `Renamed this person to ${name}.`, {
			page: "people",
			peopleOpen: id,
			peopleFocus: true,
			saved: { kind: "person", id },
		});
	}

	return c.text("Choose add, rename or remove.", 400);
});

// Only a zone the select offers is saved, and nothing else changes: "today" reads it from there
// (src/dates.ts), and a transaction's own date is never converted (decision 67).
settings.post("/settings/time-zone", async (c) => {
	const parsed = parseTimeZone(await c.req.formData());

	if (!parsed.ok)
		return renderPage(c, "household", { zoneError: parsed.error, status: 422 });
	await runWith(
		c.env.DB,
		decideSetting(
			saveTimeZoneRule,
			{ zone: parsed.zone },
			noFacts,
			timeZoneStatements,
		),
	);

	// The month follows the zone, but the Household page draws only the time zone and the bank sign-in emails, so the
	// answer carries nothing else. Categories draws the new month when it is next opened.
	return done(
		c,
		"Saved time zone",
		`Saved time zone. Months and bills now follow ${zoneLabel(parsed.zone)} time.`,
		{
			focus: "zone",
			page: "household",
			timeZone: parsed.zone,
			saved: { kind: "zone" },
		},
	);
});

/** Runs a category rule's program for this request: its database is the request's own (decision 206). */
const run = (
	c: Context<App>,
	program: Effect.Effect<Response | Promise<Response>, never, Database>,
) => runWith(c.env.DB, program);

/** The typed name, read at the edge (decision 206): the tidied name, or the sentence to show under the field. */
const typedName = (form: FormData) =>
	readAtEdge(CategoryName, String(form.get("name") ?? ""));

settings.post("/settings/categories", async (c) => {
	const form = await c.req.formData();
	const typed = typedName(form);

	if (!typed.ok) return retry(c, "new", form, { name: typed.say });

	return run(
		c,
		decideCategory(
			addCategory,
			{ name: typed.value },
			addCategoryStatements,
			saveNamedCategory,
		).pipe(
			Effect.map(({ saved }) => {
				const id = Number(saved?.[1]?.meta.last_row_id);

				return done(
					c,
					`Added ${typed.value}`,
					`Added ${typed.value}. Set its budget on Home.`,
					{ page: "categories", focus: id, saved: { kind: "category", id } },
				);
			}),
			// Every refusal of an add is about the name, and is shown under it with the form kept open.
			Effect.catch((refusal) =>
				Effect.succeed(retry(c, "new", form, { name: refusal.say })),
			),
		),
	);
});

settings.post("/settings/categories/:id{[0-9]+}", async (c) => {
	const id = readAtEdge(CategoryId, c.req.param("id"));

	if (!id.ok) return gone(c);
	const form = await c.req.formData();
	const typed = typedName(form);

	if (!typed.ok) {
		// A category that is no longer in the list has no row to show the sentence on.
		const { category } = await find(c);

		return category && !category.archived
			? retry(c, id.value, form, { name: typed.say })
			: gone(c);
	}

	return run(
		c,
		decideCategory(
			renameCategory,
			{ id: id.value, name: typed.value },
			renameCategoryStatements,
			saveNamedCategory,
		).pipe(
			// A rename marks its own row (P119 A, #71); Archive and Move take the row out of its place, so they mark
			// nothing. A rename to the name it has saves nothing and gets the same answer (decision 194).
			Effect.map(() =>
				done(c, `Saved ${typed.value}`, `Saved ${typed.value}.`, {
					page: "categories",
					focus: id.value,
					saved: { kind: "category", id: id.value },
				}),
			),
			Effect.catchTag("CategoryChanged", () => Effect.succeed(gone(c))),
			Effect.catch((refusal) =>
				Effect.succeed(retry(c, id.value, form, { name: refusal.say })),
			),
		),
	);
});

/** The name of the category a rule was asked about, from the list it decided on. */
const nameIn = (facts: CategoryFacts, id: number) =>
	facts.categories.find((x) => x.id === id)?.name ?? "";

settings.post("/settings/categories/:id{[0-9]+}/archive", async (c) => {
	const id = readAtEdge(CategoryId, c.req.param("id"));

	if (!id.ok) return gone(c);
	const today = await householdToday(c.env.DB);

	return run(
		c,
		decideCategory(
			archiveCategory,
			{ id: id.value, today },
			archiveCategoryStatements,
		).pipe(
			// A second press finds it archived already and gets the first press's answer (decision 194).
			Effect.map(({ facts }) => {
				const name = nameIn(facts, id.value);

				return done(
					c,
					`Archived ${name}`,
					`Archived ${name}. Its transactions keep their category.`,
					// Its row is gone, so focus goes to the Archived list it moved to.
					{ page: "categories", focus: "archived" },
				);
			}),
			Effect.catchTag("CategoryChanged", () => Effect.succeed(gone(c))),
		),
	);
});

settings.post("/settings/categories/:id{[0-9]+}/restore", async (c) => {
	const id = readAtEdge(CategoryId, c.req.param("id"));

	if (!id.ok) return gone(c);
	const today = await householdToday(c.env.DB);

	return run(
		c,
		decideCategory(
			restoreCategory,
			{ id: id.value, today },
			restoreCategoryStatements,
		).pipe(
			// A second press finds it back already and gets the first press's answer (decision 194).
			Effect.map(({ facts }) => {
				const name = nameIn(facts, id.value);

				return done(c, `Restored ${name}`, `Restored ${name}.`, {
					page: "categories",
					focus: id.value,
				});
			}),
			Effect.catchTags({
				CategoryChanged: () => Effect.succeed(gone(c)),
				ListFull: (refusal) =>
					Effect.succeed(
						renderPage(c, "categories", {
							restoreError: refusal.say,
							status: 422,
						}),
					),
			}),
		),
	);
});

// The direction is in the address, so every way of pressing the button sends it.
settings.post(
	"/settings/categories/:id{[0-9]+}/move/:direction{up|down}",
	async (c) => {
		const id = readAtEdge(CategoryId, c.req.param("id"));
		const direction = readAtEdge(MoveDirection, c.req.param("direction"));

		if (!id.ok || !direction.ok) return gone(c);

		// At the end of the list there is nowhere to go, and the answer says where the category is, as a move does.
		const moved = async (name: string) => {
			const timeZone = await householdTimeZone(c.env.DB);
			const today = todayIn(timeZone);
			const { active } = await settingsCategories(c.env.DB, today.slice(0, 7));
			const position = active.findIndex((x) => x.id === id.value) + 1;

			return done(
				c,
				`Moved ${name}`,
				`Moved ${name} ${direction.value}. It's now ${position} of ${active.length}.`,
				// Stay open, so the same button can be pressed again.
				{
					page: "categories",
					open: id.value,
					focus: id.value,
					today,
					timeZone,
				},
			);
		};

		return run(
			c,
			decideCategory(
				moveCategory,
				{ id: id.value, direction: direction.value },
				moveCategoryStatements,
			).pipe(
				Effect.map(({ facts }) => moved(nameIn(facts, id.value))),
				Effect.catchTag("CategoryChanged", () => Effect.succeed(gone(c))),
			),
		);
	},
);

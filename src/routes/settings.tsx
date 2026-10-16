import { type Context, Hono } from "hono";
import type { Child } from "hono/jsx";
import { actor } from "../actor";
import { askAgainLeftOut, leftOutSentence } from "../categorize-pending";
import { householdTimeZone, householdToday, todayIn } from "../dates";
import { type AiTallyCounts, readAiTally } from "../db/ai-log";
import {
	type AiSwitches,
	readAiSwitches,
	saveAiSwitches,
} from "../db/ai-switches";
import {
	addCategory,
	categoryNames,
	moveCategory,
	saveCategory,
	setArchived,
	settingsCategories,
} from "../db/categories";
import {
	createFromSuggestion,
	dismissSuggestion,
	pendingSuggestions,
} from "../db/category-suggestions";
import { merchantRules, removeMerchantRule } from "../db/merchant-rules";
import {
	neverSuggestRuleLine,
	neverSuggestRules,
	removeNeverSuggest,
} from "../db/never-suggest";
import {
	readBankSignInEmails,
	removeHouseholdMember,
	saveBankSignInEmails,
} from "../db/reconnect";
import { suggestionQueue } from "../db/suggestions-queue";
import { saveTimeZone } from "../db/time-zone";
import { hxTrigger } from "../htmx";
import { reconnectRecipients } from "../reconnect/reminders";
import {
	type CategoryErrors,
	fullMessage,
	parseCategory,
	restoreProblem,
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
import { CategorySuggestionCard } from "../views/category-suggestion-card";
import { EmptyState } from "../views/empty-state";
import { HouseholdPeople } from "../views/household-people";
import { Layout } from "../views/layout";
import {
	MERCHANT_RULE_SEARCH_THRESHOLD,
	MerchantRules,
} from "../views/merchant-rules";
import {
	SettingsContents,
	SubpageHead,
	settingsPlaces,
} from "../views/settings-pages";
import { Switch } from "../views/switch";
import { TimeZoneRow } from "../views/time-zone-row";

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
type Page = "categories" | "rules" | "household" | "people" | "ai" | "data";

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
	status?: 200 | 400 | 404 | 422;
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
	key: keyof AiSwitches;
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

/**
 * The AI switches (#606): the form posts when one is flipped, and the page answers with itself, focus back on the
 * switch that changed. Save shows only without the script. Nothing else in the form is posted.
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
		<form
			method="post"
			action="/settings/ai"
			hx-post="/settings/ai"
			hx-trigger="change, submit"
			hx-sync="replace"
			hx-target="#ai-suggestions"
			hx-select="#ai-suggestions"
			hx-swap="outerHTML"
		>
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
						/>
					</li>
				))}
			</ul>
			{nothingToSort && <input type="hidden" name={SORT_GREYED} value="1" />}
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
			currentPath={c.req.path + new URL(c.req.url).search}
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

/** Categories (#85, #195): the list with its rows, suggestions waiting, Add category and Archived. */
async function renderCategories(c: Context<App>, view: View = {}) {
	const db = c.env.DB;
	const timeZone = view.timeZone ?? (await householdTimeZone(db));
	const today = view.today ?? todayIn(timeZone);
	const { active, archived } = await settingsCategories(db, today.slice(0, 7));
	const categorySuggestions = await pendingSuggestions(db);
	const adding = view.open === "new";
	return settingsPage(
		c,
		"Categories · Settings",
		<section
			id="categories"
			aria-labelledby="categories-title"
			class="lg:max-w-3xl"
		>
			<SubpageHead title="Categories" titleId="categories-title" />
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
				{/* A suggestion whose name a category already has is added to it, or restores it when archived, not made again (decisions 101, 110). */}
				{categorySuggestions.map((suggestion) => {
					// Add to the active category with the suggested name, or Restore the archived one (decisions 101, 110).
					const named = [...active, ...archived].find((cat) =>
						sameName(cat.name, tidyName(suggestion.name)),
					);
					return (
						<CategorySuggestionCard
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
				})}
				{categorySuggestions.more > 0 && (
					<p class="py-2 text-sm text-muted">
						{categorySuggestions.more} more suggestions will show once you
						decide these.
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
	const removed = await removeMerchantRule(c.env.DB, merchantKey);
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
settings.post("/settings/never-suggest/remove", async (c) => {
	const form = await c.req.formData();
	const id = Number(form.get("id")?.toString() ?? "");
	const merchantKey = String(form.get("merchant_key") ?? "");
	const kind = String(form.get("kind") ?? "");
	const search = String(form.get("rules_search") ?? "");
	const lines = await neverSuggestRules(c.env.DB);
	const removed =
		Number.isInteger(id) && id > 0
			? await removeNeverSuggest(c.env.DB, { id, merchantKey, kind })
			: null;
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

settings.post("/settings/suggestions/:id{[0-9]+}/create", async (c) => {
	const id = Number(c.req.param("id"));
	const form = await c.req.formData();
	const ids = form
		.getAll("ids")
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0);
	const shown = form
		.getAll("shown")
		.map(Number)
		.filter((n) => Number.isInteger(n) && n > 0);
	const notes = Object.fromEntries(
		shown.map((tx) => [tx, String(form.get(`note_${tx}`) ?? "")]),
	);
	const result = await createFromSuggestion(
		c.env.DB,
		id,
		{ ticked: ids, shown, notes },
		actor(c as Context<App> & { env: Env & { DEMO: string } }),
	);
	if (!result.ok) {
		const current = await renderPage(
			c,
			"categories",
			result.reason === "gone"
				? {
						listError:
							"That suggestion was changed somewhere else. Here's the current list.",
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
	await askAgainLeftOut(
		c.env as Env & { JEV_API_KEY?: string },
		result.leftOut,
		(work) => c.executionCtx.waitUntil(work),
	);
	const count = result.moved;
	const transactions = `${count} transaction${count === 1 ? "" : "s"}`;
	const message = result.restored
		? `Restored ${result.name} with ${transactions}`
		: result.attached
			? `Added ${transactions} to ${result.name}`
			: `Created ${result.name} with ${transactions}`;
	const left = leftOutSentence(result.leftOut.length);
	return done(c, message, `${message}.${left ? ` ${left}` : ""}`, {
		page: "categories",
	});
});

settings.post("/settings/suggestions/:id{[0-9]+}/dismiss", async (c) => {
	const result = await dismissSuggestion(c.env.DB, Number(c.req.param("id")));
	if (!result)
		return renderPage(c, "categories", {
			listError:
				"That suggestion was changed somewhere else. Here's the current list.",
			status: 404,
		});
	return done(
		c,
		`Dismissed ${result.name}`,
		`Dismissed ${result.name}. Tally won't suggest it again.`,
		{ page: "categories" },
	);
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
const nameTaken = (error: unknown) =>
	error instanceof Error && /UNIQUE/.test(error.message);

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
	const n = Number(c.req.query(key));
	return Number.isInteger(n) && n > 0 ? n : undefined;
};
settings.get("/settings", (c) => renderContents(c));
settings.get("/settings/categories", (c) =>
	renderCategories(c, {
		open: numberParam(c, "open"),
		focus: numberParam(c, "focus"),
	}),
);
settings.get("/settings/rules", (c) => renderRules(c));
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

// A switch that's on posts "on" and one that's off posts nothing, so a field left out is off; the
// form always carries the whole group, so a save is always every switch it shows, and only those.
// The sorting switch is greyed out while Jev isn't asked at all (categories and income both off), and
// a greyed switch posts nothing, so Save doesn't write it at all and it stays as it was saved (spec
// §8.6, decision 79). Whether it was greyed comes from the form the person saw (a hidden field), not
// from what's saved now, since another tab may have changed the switches since the page was drawn; and
// as nothing is read and written back, a save from another tab in between is never undone.
settings.post("/settings/ai", async (c) => {
	const form = await c.req.formData();
	const next = Object.fromEntries(
		AI_FEATURES.map((f) => [f.key, form.get(f.key) === "on"]),
	) as Partial<AiSwitches>;
	if (form.get(SORT_GREYED) === "1") delete next.sortOnArrival;
	const waitingBefore = (await suggestionQueue(c.env.DB)).length;
	const before = await readAiSwitches(c.env.DB);
	await saveAiSwitches(c.env.DB, next);
	const now = await readAiSwitches(c.env.DB);
	// The switch that was flipped keeps focus after the save (#606).
	const flipped = AI_FEATURES.find((f) => before[f.key] !== now[f.key])?.key;
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
		return removeBankSignInEmail(c, String(form.get("remove") ?? ""));
	const on = form.get("enabled") === "on";
	await saveBankSignInEmails(c.env.DB, on);
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
	const email = posted.trim().toLowerCase();
	if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
		return bankSignInEmailError(c, "Choose an address to remove.", 400);
	const member = await c.env.DB.prepare(
		"SELECT 1 FROM household_members WHERE email = ?",
	)
		.bind(email)
		.first();
	if (!member) return bankSignInEmailError(c, "Address not found.", 404);
	await removeHouseholdMember(c.env.DB, email);
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
	const name = nameValue.trim();
	const id = Number(form.get("person_id"));
	if (action === "remove") {
		if (!Number.isInteger(id) || id <= 1) return c.text("Not found", 404);
		const person = await c.env.DB.prepare(
			"SELECT name FROM household_people WHERE id = ?",
		)
			.bind(id)
			.first<{ name: string }>();
		if (!person) return c.notFound();
		const [cleared] = await c.env.DB.batch([
			c.env.DB.prepare(
				"UPDATE transactions SET for_person_id = NULL, for_person_guessed = 0, updated_by = ?, updated_at = datetime('now') WHERE for_person_id = ?",
			).bind(actor(c), id),
			c.env.DB.prepare("DELETE FROM household_people WHERE id = ?").bind(id),
		]);
		const count = cleared?.meta.changes ?? 0;
		return done(
			c,
			`Removed ${person.name}`,
			`Removed ${person.name}. ${count} ${count === 1 ? "purchase" : "purchases"} for ${person.name} now say no one.`,
			{ page: "people", peopleAddOpen: true, peopleFocus: true },
		);
	}
	if (!name || name.length > 40)
		return renderPage(c, "people", {
			peopleOpen: action === "rename" ? id : undefined,
			peopleErrorPersonId: action === "rename" ? id : undefined,
			peopleAddOpen: action !== "rename",
			peopleError: "Enter a name up to 40 characters.",
			peopleValue: nameValue,
			status: 422,
		});
	if (action === "add") {
		let added: number;
		try {
			const result = await c.env.DB.prepare(
				"INSERT INTO household_people (name) VALUES (?)",
			)
				.bind(name)
				.run();
			added = result.meta.last_row_id;
		} catch (error) {
			if (nameTaken(error))
				return renderPage(c, "people", {
					peopleAddOpen: true,
					peopleError: "That name is already in your household.",
					peopleValue: nameValue,
					status: 422,
				});
			throw error;
		}
		return done(c, `Added ${name}`, `Added ${name} to your household.`, {
			page: "people",
			peopleAddOpen: true,
			peopleFocus: true,
			saved: { kind: "person", id: added },
		});
	}
	if (action === "rename" && Number.isInteger(id) && id > 1) {
		try {
			const result = await c.env.DB.prepare(
				"UPDATE household_people SET name = ? WHERE id = ?",
			)
				.bind(name, id)
				.run();
			if (!result.meta.changes) return c.notFound();
		} catch (error) {
			if (nameTaken(error))
				return renderPage(c, "people", {
					peopleOpen: id,
					peopleErrorPersonId: id,
					peopleError: "That name is already in your household.",
					peopleValue: nameValue,
					status: 422,
				});
			throw error;
		}
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
	await saveTimeZone(c.env.DB, parsed.zone);
	const today = todayIn(parsed.zone);
	// The month is the one thing in Settings that follows the zone (each category's amount is the
	// month's), and the swap below replaces only the time zone row, so every save sends those
	// amounts along. Always, not only when the two zones' months differ: a page left open past
	// midnight can show last month whichever zone is saved.
	return done(
		c,
		"Saved time zone",
		`Saved time zone. Months and bills now follow ${zoneLabel(parsed.zone)} time.`,
		{
			focus: "zone",
			page: "household",
			today,
			timeZone: parsed.zone,
			saved: { kind: "zone" },
		},
	);
});

settings.post("/settings/categories", async (c) => {
	const form = await c.req.formData();
	const parsed = parseCategory(form, await categoryNames(c.env.DB), null);
	if (!parsed.ok) return retry(c, "new", form, parsed.errors);
	let id: number | null;
	try {
		id = await addCategory(c.env.DB, parsed.value);
	} catch (error) {
		if (nameTaken(error))
			return retry(c, "new", form, { name: "That name is taken." });
		throw error;
	}
	// Another save filled the list between the form's check and this write.
	if (id === null) return retry(c, "new", form, { name: fullMessage("add") });
	return done(
		c,
		`Added ${parsed.value.name}`,
		`Added ${parsed.value.name}. Set its budget on Home.`,
		{ page: "categories", focus: id, saved: { kind: "category", id } },
	);
});

settings.post("/settings/categories/:id{[0-9]+}", async (c) => {
	const { all, category } = await find(c);
	if (!category || category.archived) return gone(c);
	const form = await c.req.formData();
	const parsed = parseCategory(form, all, category.id);
	if (!parsed.ok) return retry(c, category.id, form, parsed.errors);
	try {
		await saveCategory(c.env.DB, category.id, parsed.value);
	} catch (error) {
		if (nameTaken(error))
			return retry(c, category.id, form, { name: "That name is taken." });
		throw error;
	}
	// A rename marks its own row (P119 A, #71); Archive and Move take the row out of its place, so they mark nothing.
	return done(c, `Saved ${parsed.value.name}`, `Saved ${parsed.value.name}.`, {
		page: "categories",
		focus: category.id,
		saved: { kind: "category", id: category.id },
	});
});

settings.post("/settings/categories/:id{[0-9]+}/archive", async (c) => {
	const { category } = await find(c);
	if (!category || category.archived) return gone(c);
	await setArchived(
		c.env.DB,
		category.id,
		true,
		await householdToday(c.env.DB),
	);
	return done(
		c,
		`Archived ${category.name}`,
		`Archived ${category.name}. Its transactions keep their category.`,
		// Its row is gone, so focus goes to the Archived list it moved to.
		{ page: "categories", focus: "archived" },
	);
});

settings.post("/settings/categories/:id{[0-9]+}/restore", async (c) => {
	const { all, category } = await find(c);
	if (!category?.archived) return gone(c);
	const problem = restoreProblem(all);
	if (problem)
		return renderPage(c, "categories", { restoreError: problem, status: 422 });
	if (
		!(await setArchived(
			c.env.DB,
			category.id,
			false,
			await householdToday(c.env.DB),
		))
	) {
		// Someone restored it a moment earlier, or the list filled up.
		const now = (await find(c)).category;
		if (!now?.archived) return gone(c);
		return renderPage(c, "categories", {
			restoreError: fullMessage("restore"),
			status: 422,
		});
	}
	return done(c, `Restored ${category.name}`, `Restored ${category.name}.`, {
		page: "categories",
		focus: category.id,
	});
});

// The direction is in the address, so every way of pressing the button sends it.
settings.post(
	"/settings/categories/:id{[0-9]+}/move/:direction{up|down}",
	async (c) => {
		const { category } = await find(c);
		if (!category || category.archived) return gone(c);
		const direction = c.req.param("direction") === "up" ? "up" : "down";
		await moveCategory(c.env.DB, category.id, direction);
		const timeZone = await householdTimeZone(c.env.DB);
		const today = todayIn(timeZone);
		const { active } = await settingsCategories(c.env.DB, today.slice(0, 7));
		const position = active.findIndex((x) => x.id === category.id) + 1;
		return done(
			c,
			`Moved ${category.name}`,
			`Moved ${category.name} ${direction}. It's now ${position} of ${active.length}.`,
			// Stay open, so the same button can be pressed again.
			{
				page: "categories",
				open: category.id,
				focus: category.id,
				today,
				timeZone,
			},
		);
	},
);

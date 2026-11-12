import * as Effect from "effect/Effect";
import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { addressOf } from "../address";
import { askAgainLeftOut, leftOutSentence } from "../categorize-pending";
import { householdToday } from "../dates";
import { categoryNames } from "../db/categories";
import {
	createFromSuggestion,
	dismissSuggestion,
} from "../db/category-suggestions";
import { type Database, runWith } from "../db/database";
import {
	type NameChoice,
	type NameReview,
	settleSuggestion,
} from "../db/merchant-names";
import {
	addMoreLikeThis,
	type MoreLikeThis,
	moreLikeThis,
} from "../db/more-like-this";
import {
	NEVER_SUGGEST_KINDS,
	type NeverSuggestKind,
} from "../db/never-suggest";
import {
	FULL_NEW_CATEGORY,
	fileInNewCategory,
	type NewCategoryTarget,
	newCategoryTarget,
	pendingCategoryNames,
	suggestedCategoryName,
} from "../db/new-category-answer";
import { runningRecheck, startResortFor } from "../db/resort-start";
import {
	decideCategoryMaybe,
	decideMoneyMaybe,
	decideNeverSuggest,
} from "../db/suggestion-saves";
import {
	categoryAskedSql,
	neverSuggestAskedSql,
	type SuggestionItem,
	suggestionQueue,
} from "../db/suggestions-queue";
import { readAtEdge } from "../edge";
import { hxTrigger } from "../htmx";
import { DISPLAY_NAME_MAX, MERCHANT_KEY_MAX } from "../limits";
import { STARTED_ANNOUNCEMENT } from "../resort-toast";
import {
	type AlreadyAnswered,
	acceptCategoryGuess,
	answerMoneyMaybe,
	chooseCategory,
	type NeverSuggestRequest,
	neverSuggestStores,
} from "../rules/suggestions";
import { CategoryId } from "../settings/category-form";
import { tidyName } from "../transactions/tidy-name";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import { OWN_VALUE, pickValue, STORE_VALUE } from "../views/name-choices";
import { RecheckLine, type RecheckRun } from "../views/recheck-line";
import {
	AskFirst,
	type CardValues,
	ExistingCategoryRow,
	joinStores,
	MoreLikeThisCard,
	NewCategoryRow,
	SuggestionCard,
	suggestedRow,
} from "../views/suggestion-review";

type App = { Bindings: Env & { JEV_API_KEY?: string; AI?: Ai } };

const PATH = "/settings/suggestions";

/** The words when a suggestion was answered somewhere else first (decision 120): Settings and Organize say the same. */
export const CHANGED_SUGGESTION =
	"That suggestion was changed somewhere else. Here's the current list.";

/** What a stale "Add to …" card says: the purchase moved elsewhere since the card was drawn, so nothing moved. */
export const MORE_CHANGED =
	"That purchase was changed somewhere else, so nothing moved.";

/** A question the No just raised: its store(s) and what the check says (decision 101). */
type Ask = {
	kind: "income" | "transfer" | "new_category";
	id: string;
	name?: string;
	stores: { merchantKey: string; label: string }[];
	check?: string;
};

/** What the form held when it was posted, shown again with its error (the card's values, and the item's id). */
type Values = CardValues & { id: string };

/** The words when a one tap's category is gone or archived since the card was drawn (#965). */
const CATEGORY_GONE = "That category is gone. Choose another.";

/** The active category with this id, read from a posted field, or null. Number("") is 0, so the empty text is checked first. */
async function activeCategoryById(
	db: D1Database,
	raw: string,
): Promise<{ id: number; name: string } | null> {
	const text = raw.trim();
	const chosen = Number(text);

	if (text === "" || !Number.isInteger(chosen)) return null;

	return db
		.prepare("SELECT id, name FROM categories WHERE id = ? AND archived = 0")
		.bind(chosen)
		.first<{ id: number; name: string }>();
}

export const suggestions = new Hono<App>();

/**
 * The address of the screen with its skips in it, so every form keeps the skips it was drawn with. `skip`
 * holds the items set aside; `again` holds those set aside a second time, after they came back (decision 79).
 */
export function reviewAddress(
	skipped: string[],
	again: string[] = [],
	/** The filed purchase whose "N more look like this" card the screen shows (decision 157): its id only. */
	more?: number,
): string {
	const query = new URLSearchParams();

	for (const id of skipped) query.append("skip", id);

	for (const id of again) query.append("again", id);

	if (more !== undefined) query.set("more", String(more));

	return query.size ? `${PATH}?${query}` : PATH;
}

/** The `more` address key as a purchase id, or undefined when it isn't one (an id only, never bank text). */
function moreFrom(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d{1,15}$/.test(value)) return undefined;

	return Number(value);
}

/** The skip keys of one address key, kept only when the queue still has them (never bank text). */
function requestedKeys(
	url: string,
	key: "skip" | "again",
	ids: Set<string>,
): string[] {
	const requested = queryOf(url).getAll(key);

	return [...new Set(requested)].filter(
		(id) => QUEUE_ID.test(id) && ids.has(id),
	);
}

/** A queue item's id as the address spells it: "income-1", "category-3", "new-4", "name-8" (never bank text). */
const QUEUE_ID = /^[a-z]+-\d{1,9}$/;

/**
 * The query of an address the client sent (the page's own address, from HX-Current-URL, is client data). Only an
 * absolute URL is read, and only its query; anything that doesn't parse gives no query, so a bad header is never a 500.
 */
function queryOf(url: string): URLSearchParams {
	try {
		return new URL(url).searchParams;
	} catch {
		return new URLSearchParams();
	}
}

/** What the address says about the review: the items set aside, and those set aside again. */
type RequestedReview = { skipped: string[]; again: string[] };

function requestedReview(
	url: string,
	queue: SuggestionItem[],
): RequestedReview {
	const ids = new Set(queue.map((item) => item.id));
	const skipped = requestedKeys(url, "skip", ids);
	const skippedSet = new Set(skipped);

	return {
		skipped,
		again: requestedKeys(url, "again", ids).filter((id) => skippedSet.has(id)),
	};
}

/**
 * The version of the name's loader address. Browsers keep a response from before this rollout for a day (its old
 * `private, max-age=86400`), so the loader's URL changes with each version and the old cached answer is never reused.
 * The GET accepts the parameter and ignores it.
 */
export const NAME_URL_VERSION = 2;

/**
 * The address that answers with a category guess's suggested new category (decision 156). It names the item and this
 * version only, never a store's text (a bank's text can carry a card or account number, and a URL is logged), and never
 * the screen's skips: the address is the same wherever the card is reached, and the kept answer in maybe_names holds
 * (decision 161). The row's answer finds the skips from the page it was answered on (HX-Current-URL), see the POST below.
 */
function newCategoryAddress(id: string): string {
	return `${PATH}/new-category?${new URLSearchParams({ id, v: String(NAME_URL_VERSION) })}`;
}

/** Skip: the first one sets the item aside; on an item that came back, it sets it aside for good. */
function skipAddress(item: SuggestionItem, skipped: string[], again: string[]) {
	return skipped.includes(item.id)
		? reviewAddress(skipped, [...again, item.id])
		: reviewAddress([...skipped, item.id], again);
}

/** Store labels for the question and toasts: the store's name, or its key tidied (spec §8.6). */
async function storeLabels(
	db: D1Database,
	keys: string[],
): Promise<Map<string, string>> {
	const labels = new Map(keys.map((key) => [key, tidyName(key)]));

	if (keys.length === 0) return labels;

	const { results } = await db
		.prepare(
			`SELECT raw_name AS key, display_name AS name FROM merchants
			WHERE raw_name IN (SELECT value FROM json_each(?)) AND display_name IS NOT NULL AND display_name != ''`,
		)
		.bind(JSON.stringify(keys))
		.all<{ key: string; name: string }>();

	for (const row of results) labels.set(row.key, row.name);

	return labels;
}

/**
 * Yes on a question (decision 101): the rule keeps one "Never suggest" line for each store the question still asks
 * about, so a No that changed under it writes nothing (#440). Returns the stores' labels, or null when the rule
 * refuses because the question is no longer asked. Settings' categories asks the same question after its No (decision 120).
 */
export async function writeNeverSuggest(
	db: D1Database,
	request: NeverSuggestRequest,
): Promise<string | null> {
	const kept = await runWith(
		db,
		decideNeverSuggest(neverSuggestStores, request).pipe(
			Effect.catchTag("AlreadyAnswered", () => Effect.succeed(null)),
		),
	);

	return kept && joinStores([...(await storeLabels(db, kept)).values()]);
}

/** The toast's and announcement's words once a question's Yes has written its lines (decision 101). */
export function neverSuggestedMessage(
	kind: NeverSuggestKind,
	labels: string,
): string {
	return kind === "income"
		? `Got it. Tally won't suggest income for ${labels} again. Change it in Settings.`
		: kind === "transfer"
			? `Got it. Tally won't suggest a transfer for ${labels} again. Change it in Settings.`
			: `Got it. Tally won't suggest a new category for ${labels} again. Change it in Settings.`;
}

/**
 * The stores a No on a suggested new category asks about (decision 101), read once the suggestion is dismissed. It is the
 * check the question's Yes writes with, so the question and its line can't disagree, and it doesn't read the Suggestions
 * queue, whose new categories follow Guess categories (decision 79); Settings' card doesn't follow that switch either.
 */
export async function askedStores(
	db: D1Database,
	id: number,
): Promise<{ merchantKey: string; label: string }[]> {
	const { results } = await db
		.prepare(`SELECT key FROM (${neverSuggestAskedSql("new_category")})`)
		.bind(id)
		.all<{ key: string }>();

	const keys = results.map((row) => row.key);
	const labels = await storeLabels(db, keys);

	return keys.map((key) => ({
		merchantKey: key,
		label: labels.get(key) ?? key,
	}));
}

/** The screen as it is now, with the item to show, and the Band count's words. */
type ScreenInput = {
	skipped: string[];
	again: string[];
	queue: SuggestionItem[];
	ask?: Ask;
	values?: Values;
	error?: string;
	focus?: boolean;
	today: string;
	categories: { id: number; name: string }[];
	/** The pending category suggestion's name for each store, drawn in place with no script (decision 156). */
	pendingNames: Map<string, string>;
	/** The "N more look like this" card above the screen, when a purchase was just filed and others look like it. */
	more: MoreLikeThis | null;
	/** The re-check's run while it goes, drawn as its progress line (decision 159, #821). */
	recheck: RecheckRun | null;
};

function Screen({
	input,
	demo,
	address,
}: {
	input: ScreenInput;
	demo: boolean;
	/** The address the screen was asked for, with its query, so the keys sheet can open over it. */
	address: string;
}) {
	const {
		skipped,
		again,
		queue,
		ask,
		values,
		error,
		focus = false,
		today,
		more,
		recheck,
	} = input;

	const skippedSet = new Set(skipped);
	const againSet = new Set(again);
	// The items not set aside come first. Then the skipped ones come back in queue order, and a second Skip
	// on one of them sets it aside for good, so "You skipped the rest." shows once they are all set aside.
	const firstPass = queue.filter((item) => !skippedSet.has(item.id));

	const returned = queue.filter(
		(item) => skippedSet.has(item.id) && !againSet.has(item.id),
	);

	const current =
		(values && queue.find((item) => item.id === values.id)) ||
		firstPass[0] ||
		returned[0];

	const position = current
		? queue.findIndex((item) => item.id === current.id) + 1
		: 0;

	const total = queue.length;
	// Every form posts to this screen's address, so the skips it was drawn with carry over.
	const action = reviewAddress(skipped, again);

	return (
		<Layout
			title="Suggestions · Tally"
			active="settings"
			demo={demo}
			currentPath={address}
		>
			<div id="suggestions-page" class="lg:max-w-3xl">
				<a
					href="/settings"
					class="inline-flex min-h-11 items-center text-accent"
				>
					Settings
				</a>
				<RecheckLine run={recheck} page="suggestions" />
				{/* While the card shows it is the whole screen: a purchase it offers is never also offered by the queue below. */}
				{more ? (
					<div class="mt-6">
						<MoreLikeThisCard
							action={action}
							card={more}
							today={today}
							focus={focus}
						/>
					</div>
				) : null}
				{/* The question has no count: the item it asks about has just left the queue, so "0 left" would read wrong. */}
				{more ? null : ask ? (
					<div class="mt-6">
						<AskFirst
							action={action}
							kind={ask.kind}
							id={ask.id}
							name={ask.name}
							stores={ask.stores}
							check={ask.check}
							focus={focus}
						/>
					</div>
				) : current ? (
					<>
						<p class="mt-2 text-muted">
							Suggestions · {position} of {total}
						</p>
						<div class="mt-6">
							<SuggestionCard
								action={action}
								item={current}
								today={today}
								categories={input.categories}
								skipHref={skipAddress(current, skipped, again)}
								values={values?.id === current.id ? values : undefined}
								error={error}
								focus={focus}
								// Without JavaScript the lazy address never loads, so only a pending name (already
								// in the database) is drawn here; an AI-only name shows with JavaScript, and Yes and
								// Something else still answer without it.
								suggestedName={
									current.kind === "category"
										? input.pendingNames.get(current.merchantKey)
										: undefined
								}
								suggestUrl={
									current.kind === "category"
										? newCategoryAddress(current.id)
										: undefined
								}
							/>
						</div>
					</>
				) : skipped.length > 0 ? (
					<div
						tabindex={focus ? -1 : undefined}
						autofocus={focus || undefined}
						class="mt-2 outline-none"
					>
						<EmptyState
							kind="done"
							sentence="You skipped the rest."
							action={{ href: PATH, label: "Start over" }}
						/>
					</div>
				) : (
					<div
						tabindex={focus ? -1 : undefined}
						autofocus={focus || undefined}
						class="mt-2 outline-none"
					>
						<EmptyState
							kind="done"
							sentence="Nothing left to check."
							hint="New suggestions show up as transactions arrive."
							action={{ href: "/settings", label: "Back to Settings" }}
						/>
					</div>
				)}
			</div>
		</Layout>
	);
}

async function renderScreen(
	c: Context<App>,
	options: {
		ask?: Ask;
		values?: Values;
		error?: string;
		status?: 200 | 422;
		focus?: boolean;
		toast?: { message: string; type: "success" | "info"; announce: string };
		/** The address the screen's skips are read from; the page's own address when none is given (a row's answer). */
		reviewUrl?: string;
		/** The page's address for its keys sheet, when it is not this request's (an Undo answer's back address). */
		address?: string;
		/** The purchase just filed, whose "N more look like this" card the screen shows (decision 157). */
		more?: number;
	} = {},
) {
	const db = c.env.DB;
	const queue = await suggestionQueue(db);

	const { skipped, again } = requestedReview(
		options.reviewUrl ?? c.req.url,
		queue,
	);

	const more =
		options.more === undefined ? null : await moreLikeThis(db, options.more);

	const categories = await db
		.prepare(
			"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order, name",
		)
		.all<{ id: number; name: string }>();

	if (options.toast) {
		c.header(
			"HX-Trigger",
			hxTrigger({
				toast: {
					message: options.toast.message,
					type: options.toast.type,
				},
				announce: options.toast.announce,
			}),
		);
	}

	return c.html(
		<Screen
			demo={c.env.DEMO === "true"}
			address={options.address ?? addressOf(c)}
			input={{
				skipped,
				again,
				queue,
				ask: options.ask,
				values: options.values,
				error: options.error,
				focus: options.focus,
				today: await householdToday(db),
				categories: categories.results,
				pendingNames: await pendingCategoryNames(
					db,
					queue.flatMap((item) =>
						item.kind === "category" ? [item.merchantKey] : [],
					),
				),
				more,
				recheck: await runningRecheck(db),
			}}
		/>,
		options.status ?? 200,
	);
}

/** The suggestions screen again, for an Undo answer of the re-check (decision 160): the page the toast was shown on. */
export function suggestionsAgain(c: Context<App>, back: URL) {
	return renderScreen(c, {
		reviewUrl: back.href,
		address: back.pathname + back.search,
	});
}

/** What the announcer says after an answer: how many are left to check. */
const left = (queue: SuggestionItem[]) =>
	queue.length === 0
		? "Nothing left to check."
		: `${queue.length} left to check.`;

// Settings → Suggestions (issue #195, decision 101): one item at a time, like Organize. A `more` address shows the
// "N more look like this" card after a create, when the purchase it names was just filed (decision 157).
suggestions.get(PATH, (c) =>
	renderScreen(c, { more: moreFrom(c.req.query("more")) }),
);

// A category guess's suggested new category, asked for in place once its card is on screen (decision 156): the dashed
// row with Tally's name, or nothing when Tally has no name (no AI, the switch off, or a failed call). The row's swap
// is announced, and the name is never logged. Workers AI is asked once for each transaction and its answer is kept on
// the server (decision 161), so a card drawn again reads the kept answer; the response is never cached by the browser
// (no-store), so a stale name isn't served. The URL names the item, never a store's text.
suggestions.get(`${PATH}/new-category`, async (c) => {
	c.header("Cache-Control", "no-store");
	const db = c.env.DB;
	const queue = await suggestionQueue(db);
	const { skipped, again } = requestedReview(c.req.url, queue);
	const id = c.req.query("id") ?? "";
	const item = queue.find((candidate) => candidate.id === id);

	// An answered or unknown item gets nothing: the name is read from the item here, never from the address.
	if (item?.kind !== "category") return c.body(null);
	// The AI binding is optional: the tests and a local run have none, and a missing one means no name.
	const ai = c.env.AI;
	const name = await suggestedCategoryName(db, ai, item);
	const categories = (await categoryNames(db)).filter((c) => !c.archived);

	// The name is asked and kept as it was (decision 161); the one function decides the row (#965): a name that is the
	// guess itself, or none, draws nothing (decision 166), the same empty answer as no name.
	const row = suggestedRow({
		guess: item.category,
		suggested: name ?? undefined,
		categories,
	});

	if (row.kind === "none") return c.body(null);
	const action = reviewAddress(skipped, again);

	// Announce only, never a toast: a passive suggestion appearing is not an answer or a change (CLAUDE.md names toast + announce for those).
	if (row.kind === "existing") {
		c.header(
			"HX-Trigger",
			hxTrigger({
				announce: `Tally suggests an existing category: ${row.category.name}`,
			}),
		);

		return c.html(
			<ExistingCategoryRow
				action={action}
				itemId={item.id}
				category={row.category}
			/>,
		);
	}

	c.header(
		"HX-Trigger",
		hxTrigger({ announce: `Tally suggests a new category: ${row.name}` }),
	);

	// The new row empties Something else's new-name field out of band, so the card offers one new-category place (#965).
	// htmx swaps an out-of-band element by its id, and the wrapper is on the card from the first draw.
	return c.html(
		<>
			<NewCategoryRow
				action={action}
				itemId={item.id}
				fieldId={item.id}
				name={row.name}
			/>
			<div id={`else-new-${item.id}`} hx-swap-oob="outerHTML" />
		</>,
	);
});

// The names review it replaces: its address goes to the screen (the names it held are in the queue now).
suggestions.get("/settings/names", (c) => c.redirect(PATH, 303));

suggestions.post("/settings/names", (c) => c.redirect(PATH, 303));

suggestions.post(PATH, async (c) => {
	const db = c.env.DB;
	const form = await c.req.formData();
	const answer = form.get("answer")?.toString() ?? "";
	const id = form.get("id")?.toString() ?? "";
	const who = actor(c);
	const today = await householdToday(db);
	const queue = await suggestionQueue(db);

	// A new category row (decision 156) posts to the screen's bare address, so its skips come from the page it was
	// answered on (htmx sends that address as HX-Current-URL). Every other answer posts to the page's own address.
	const reviewUrl =
		answer === "create"
			? (c.req.header("HX-Current-URL") ?? c.req.url)
			: c.req.url;

	const { skipped, again } = requestedReview(reviewUrl, queue);
	const next = reviewAddress(skipped, again);

	// `extra` is one more sentence for the announcer, such as what a create left out; the toast keeps its words.
	// `more` is the purchase a create just filed: its "N more look like this" card, when others look like it (decision 157).
	const done = (
		message: string,
		queueAfter: SuggestionItem[],
		extra = "",
		more?: number,
	) => {
		if (!c.req.header("HX-Request"))
			return c.redirect(reviewAddress(skipped, again, more), 303);

		return renderScreen(c, {
			reviewUrl,
			more,
			focus: true,
			toast: {
				message,
				type: "success",
				announce: `${message.replace(/\.$/, "")}. ${extra ? `${extra} ` : ""}${left(queueAfter)}`,
			},
		});
	};

	const stale = async () => {
		const message = "That one was already answered.";

		if (!c.req.header("HX-Request")) return c.redirect(next, 303);

		return renderScreen(c, {
			reviewUrl,
			focus: true,
			toast: { message, type: "info", announce: message },
		});
	};

	// The question after a No: Yes writes one line per store, Not now writes nothing (decision 101).
	if (answer === "ask_yes" || answer === "ask_not_now") {
		const kind = form.get("kind")?.toString() ?? "";

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

		const knownKind = NEVER_SUGGEST_KINDS.find((known) => known === kind);

		if (knownKind === undefined || stores.length === 0) return stale();

		if (answer === "ask_not_now") {
			const message = "Kept it as it is.";

			if (!c.req.header("HX-Request")) return c.redirect(next, 303);

			return renderScreen(c, {
				focus: true,
				toast: { message, type: "info", announce: `${message} ${left(queue)}` },
			});
		}

		// Only the question's own stores get a line, and only while the question is still current (decision 101): the
		// check sits inside the INSERT, so a No that changes under this write writes nothing (#440). The statement
		// returns the stores it wrote, so the toast names only those.
		const found = /^(income|transfer|new)-(\d+)$/.exec(id);

		if (!found || (found[1] === "new" ? "new_category" : found[1]) !== kind)
			return stale();

		const labels = await writeNeverSuggest(db, {
			kind: knownKind,
			itemId: Number(found[2]),
			stores,
			today,
		});

		if (labels === null) return stale();
		// The line hides the store's other items, so the count is taken once it is written.
		const after = await suggestionQueue(db);

		return done(neverSuggestedMessage(knownKind, labels), after);
	}

	// The "N more look like this" card (decision 157, step A), drawn after a create. "No" moves on and records nothing,
	// and makes no "Never suggest" line (decision 101). Add files only the ticked purchases still waiting, read from
	// the group as it is now: the ids posted are checked against it, never trusted.
	if (answer === "more_skip") {
		const message = "Left them as they are.";

		if (!c.req.header("HX-Request")) return c.redirect(next, 303);

		return renderScreen(c, {
			focus: true,
			toast: { message, type: "info", announce: `${message} ${left(queue)}` },
		});
	}

	if (answer === "more_add") {
		const filedId = moreFrom(form.get("more")?.toString());
		const category = moreFrom(form.get("category")?.toString());

		const result =
			filedId === undefined || category === undefined
				? ({ ok: false, reason: "gone" } as const)
				: await addMoreLikeThis(db, {
						filedId,
						category,
						ticked: form
							.getAll("ticked")
							.map((value) => Number(value.toString()))
							.filter(Number.isSafeInteger),
						who,
					});

		if (!result.ok && result.reason === "changed") {
			// The card was drawn before the purchase moved to another category: nothing moved, and the next screen shows.
			const message = MORE_CHANGED;

			if (!c.req.header("HX-Request")) return c.redirect(next, 303);

			return renderScreen(c, {
				reviewUrl,
				focus: true,
				toast: {
					message,
					type: "info",
					announce: `${message} ${left(queue)}`,
				},
			});
		}

		if (!result.ok) return stale();
		const after = await suggestionQueue(db);
		const { skipped: decided } = result;

		const changed =
			decided === 0
				? ""
				: ` ${decided} ${decided === 1 ? "was" : "were"} changed somewhere else, so ${decided === 1 ? "it was" : "they were"} left alone.`;

		if (result.moved === 0) {
			const message = `Nothing moved.${changed}`;

			if (!c.req.header("HX-Request")) return c.redirect(next, 303);

			return renderScreen(c, {
				reviewUrl,
				focus: true,
				toast: {
					message,
					type: "info",
					announce: `${message} ${left(after)}`,
				},
			});
		}

		return done(`Moved ${result.moved} to ${result.name}.${changed}`, after);
	}

	const item = queue.find((candidate) => candidate.id === id);

	if (!item) return stale();

	/** Runs an answer's rule and save. False when the rule refuses because the question was already answered. */
	const answered = <A,>(program: Effect.Effect<A, AlreadyAnswered, Database>) =>
		runWith(
			db,
			program.pipe(
				Effect.as(true),
				Effect.catchTag("AlreadyAnswered", () => Effect.succeed(false)),
			),
		);

	switch (item.kind) {
		case "income":
		case "transfer": {
			if (answer !== "yes" && answer !== "no") break;
			const income = item.kind === "income";

			// A No changes nothing that counts: it hides this one Maybe (decision 101), and the question asks first.
			const saved = await answered(
				decideMoneyMaybe(answerMoneyMaybe, {
					kind: item.kind,
					answer,
					transactionId: item.transactionId,
					today,
					who,
				}),
			);

			if (!saved) return stale();

			if (answer === "no")
				return askScreen(c, {
					kind: item.kind,
					id: item.id,
					stores: [{ merchantKey: item.merchantKey, label: item.merchant }],
					check: income ? "Not counted as income" : "Kept in the budget",
				});

			return done(
				income
					? `Counted ${item.label} as income.`
					: `Left ${item.label} out of the budget.`,
				await suggestionQueue(db),
			);
		}

		case "category": {
			if (answer === "yes") {
				const saved =
					item.categoryId !== null &&
					(await answered(
						decideCategoryMaybe(acceptCategoryGuess, {
							transactionId: item.transactionId,
							categoryId: item.categoryId,
							today,
							who,
						}),
					));

				if (!saved) return stale();

				return done(
					`Set ${item.label} to ${item.category}.`,
					await suggestionQueue(db),
				);
			}

			// The category answers each do one thing (#965). A create with a category is the one tap; a create with a name is the
			// dashed new row. Both file through filedAs, so the create, the filing and the re-check are one path.
			// The purchase is filed in an active category the family has, or in a new one made from the typed name.
			const filedAs = async (
				target: Exclude<NewCategoryTarget, { ok: false }>,
				refuse: (nameError?: string) => Values,
				typedByPerson: boolean,
			) => {
				const result = await fileInNewCategory(db, {
					transactionId: item.transactionId,
					target,
					today,
					who,
					typedByPerson,
				});

				if (!result.ok) {
					if (result.reason === "gone") return stale();

					return renderScreen(c, {
						reviewUrl,
						values: refuse(),
						error: FULL_NEW_CATEGORY,
						status: 422,
						focus: true,
					});
				}

				// Only a new category starts the re-check (decision 157): an Add to changes nothing the run would sort.
				// The card's same-text peers (the "N more look like this" offer) are read before the run starts and kept out of
				// it, so the card still offers them to the person (#842 round 2).
				const rechecking = result.created
					? await startResortFor(c.env, db, {
							filedId: item.transactionId,
							excludeIds: (
								(await moreLikeThis(db, item.transactionId))?.rows ?? []
							).map((row) => row.id),
						})
					: null;

				const after = await suggestionQueue(db);

				return done(
					result.created
						? `Made ${result.name} and set ${item.label} to it.`
						: `Added ${item.label} to ${result.name}.`,
					after,
					rechecking ? STARTED_ANNOUNCEMENT : "",
					item.transactionId,
				);
			};

			// A typed name, checked as the category form checks it (decision 156): a name the family already has files the
			// purchase in that one, and a refused name redraws the card with `refuse`'s values and its error on the field.
			const typedName = async (
				typed: string,
				refuse: (nameError?: string) => Values,
				typedByPerson: boolean,
			) => {
				const target = newCategoryTarget(typed, await categoryNames(db));

				if (target.ok) return filedAs(target, () => refuse(), typedByPerson);

				// The limit is the card's message; a refused name is named by its own field (aria-invalid).
				const limit = target.error === FULL_NEW_CATEGORY;

				return renderScreen(c, {
					reviewUrl,
					values: refuse(limit ? undefined : target.error),
					error: limit ? target.error : undefined,
					status: 422,
					focus: true,
				});
			};

			// The dashed row (decision 156, #965): the one tap posts the category's id; the new row posts only a name.
			if (answer === "create") {
				if (form.has("category")) {
					const category = await activeCategoryById(
						db,
						form.get("category")?.toString() ?? "",
					);

					if (!category)
						return renderScreen(c, {
							reviewUrl,
							values: { id },
							error: CATEGORY_GONE,
							status: 422,
							focus: true,
						});

					return filedAs(
						{
							ok: true,
							kind: "existing",
							id: category.id,
							name: category.name,
						},
						() => ({ id }),
						false,
					);
				}

				const typed = String(form.get("new_name") ?? "");

				return typedName(
					typed,
					(nameError) => ({ id, newName: typed, newNameError: nameError }),
					false,
				);
			}

			// Something else (#965): one category, or one new name, never both. A name with no category is made the same way
			// as the new row's; a blank name beside a chosen category counts as no name.
			if (answer === "else") {
				const category = form.get("category")?.toString() ?? "";
				const typed = form.get("new_name")?.toString() ?? "";
				const hasCategory = category.trim() !== "";
				const hasName = typed.trim() !== "";

				if (!hasCategory && !hasName)
					return renderScreen(c, {
						values: { id },
						error: "Choose a category, or type a name for a new one.",
						status: 422,
						focus: true,
					});

				if (hasCategory && hasName)
					return renderScreen(c, {
						values: { id, elseName: typed, elseCategory: category },
						error: "Choose a category or type a new name, not both.",
						status: 422,
						focus: true,
					});

				if (hasName)
					return typedName(
						typed,
						(nameError) => ({ id, elseName: typed, elseNameError: nameError }),
						true,
					);

				const gone = () =>
					renderScreen(c, {
						values: { id },
						error: CATEGORY_GONE,
						status: 422,
						focus: true,
					});

				const chosenId = readAtEdge(CategoryId, category.trim());

				if (!chosenId.ok) return gone();

				const name = await runWith(
					db,
					decideCategoryMaybe(chooseCategory, {
						transactionId: item.transactionId,
						categoryId: chosenId.value,
						today,
						who,
					}).pipe(
						Effect.map(({ facts }) => facts.chosen?.name ?? ""),
						Effect.catchTags({
							CategoryGone: () => Effect.succeed(null),
							AlreadyAnswered: () => Effect.succeed(undefined),
						}),
					),
				);

				if (name === null) return gone();

				if (name === undefined) return stale();

				return done(`Set ${item.label} to ${name}.`, await suggestionQueue(db));
			}

			break;
		}

		case "new_category": {
			if (answer === "yes") {
				// Only the rows this question shows can be filed, whatever an older form posted (decision 101).
				const asked = new Set(item.rows.map((row) => row.transactionId));

				const shown = form
					.getAll("shown")
					.map((value) => Number(value.toString()))
					.filter((n) => Number.isInteger(n) && asked.has(n));

				const ticked = form
					.getAll("ticked")
					.map((value) => Number(value.toString()))
					.filter((n) => Number.isInteger(n) && asked.has(n));

				// The note under an unticked purchase is kept with the answer, as Settings keeps it (decision 120).
				const notes = Object.fromEntries(
					shown.map((tx) => [tx, String(form.get(`note_${tx}`) ?? "")]),
				);

				const result = await createFromSuggestion(
					db,
					item.suggestionId,
					{ ticked, shown, notes },
					who,
				);

				if (!result.ok) {
					if (result.reason === "gone") return stale();

					return renderScreen(c, {
						values: { id, ticked, notes },
						error:
							result.error ??
							"Tick at least one transaction, or say No to this suggestion.",
						status: 422,
						focus: true,
					});
				}

				await askAgainLeftOut(c.env, result.leftOut, (work) =>
					c.executionCtx.waitUntil(work),
				);
				// Only a new category starts the re-check (decision 157): a restore or an Add to changes nothing it would sort.
				const created = !result.attached && !result.restored;
				const [filedId] = result.filed;

				const rechecking =
					created && filedId !== undefined
						? await startResortFor(c.env, db, {
								filedId,
								excludeIds: [...result.leftOut, ...result.filed],
							})
						: null;

				const after = await suggestionQueue(db);

				const message = result.restored
					? `Restored ${result.name} with ${result.moved} ${result.moved === 1 ? "transaction" : "transactions"}.`
					: result.attached
						? `Added ${result.moved} ${result.moved === 1 ? "transaction" : "transactions"} to ${result.name}.`
						: `Made ${result.name} with ${result.moved} ${result.moved === 1 ? "transaction" : "transactions"}.`;

				return done(
					message,
					after,
					[
						leftOutSentence(result.leftOut.length),
						rechecking ? STARTED_ANNOUNCEMENT : "",
					]
						.filter(Boolean)
						.join(" "),
				);
			}

			if (answer === "no") {
				const dismissed = await dismissSuggestion(db, item.suggestionId);

				if (!dismissed) return stale();

				return askScreen(c, {
					kind: "new_category",
					id: item.id,
					name: item.name,
					stores: item.stores.map((store) => ({
						merchantKey: store.merchantKey,
						label: store.merchant,
					})),
				});
			}

			break;
		}

		case "name": {
			const review = item.review;
			// A charge with its own name keeps it when the merchant is named, so only the others change (decision 101).
			const changed = review.count - review.owned;

			if (answer === "yes") {
				const value: NameChoice = {
					kind: "name",
					name: review.names[0] ?? review.tidied,
				};

				const settled = await settleSuggestion(db, item.merchantKey, value);

				if (!settled) return stale();
				const after = await suggestionQueue(db);

				return done(savedMessage(value, changed), after);
			}

			if (answer === "else") {
				const picked = form.get("name_pick")?.toString() ?? null;
				const own = form.get("merchant")?.toString().trim() ?? "";
				const choice = readChoice(review, picked, own);

				if (!choice.ok)
					return renderScreen(c, {
						values: { id, picked, own },
						error: choice.error,
						status: 422,
					});

				const settled = await settleSuggestion(
					db,
					item.merchantKey,
					choice.value,
				);

				if (!settled) return stale();
				const after = await suggestionQueue(db);

				return done(savedMessage(choice.value, changed), after);
			}

			break;
		}
	}

	return stale();
});

/**
 * The question after a No, drawn in place of the item. It is drawn here rather than redirected, since
 * the question exists only in this response (its stores come back from the form). Without JavaScript
 * this is the one answer that is not a redirect: a reload re-posts the No, and that post finds the item
 * already answered (it has left the queue), so it redirects like any other stale answer.
 */
function askScreen(c: Context<App>, ask: Ask) {
	return renderScreen(c, { ask, focus: true });
}

/** What a person chose on the Name row (decision 101): the typed name under "Type your own", the store's own name, or a suggestion the form showed. */
function readChoice(
	review: NameReview,
	picked: string | null,
	own: string,
): { ok: true; value: NameChoice } | { ok: false; error: string } {
	// A typed name counts only while "Type your own" is ticked (decision 101).
	if (picked === OWN_VALUE) {
		if (own === "")
			return { ok: false, error: "Type a name here, or pick one above." };

		if (own.length > DISPLAY_NAME_MAX)
			return {
				ok: false,
				error: `Keep the name under ${DISPLAY_NAME_MAX} characters.`,
			};

		return { ok: true, value: { kind: "name", name: own } };
	}

	if (picked === STORE_VALUE) return { ok: true, value: { kind: "keep" } };
	const name = review.names.find((n) => pickValue(n) === picked);

	if (name) return { ok: true, value: { kind: "name", name } };

	return {
		ok: false,
		error: picked
			? "Pick one of the names shown."
			: "Pick a name, keep the bank's, or type your own.",
	};
}

/**
 * The toast's words for a saved choice, counting only the charges whose shown name changed. When every charge
 * keeps its own name, nothing is counted and the words say the choice is for the transactions that come later.
 */
function savedMessage(choice: NameChoice, changed: number): string {
	const word = changed === 1 ? "transaction" : "transactions";

	if (changed === 0)
		return choice.kind === "keep"
			? "Kept the bank's name for the transactions that come later"
			: `Saved ${choice.name} for the transactions that come later`;

	return choice.kind === "keep"
		? `Kept the bank's name for ${changed} ${word}`
		: `Renamed ${changed} ${word} to ${choice.name}`;
}

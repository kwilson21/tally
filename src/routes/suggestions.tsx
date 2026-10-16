import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { addressOf } from "../address";
import { askAgainLeftOut, leftOutSentence } from "../categorize-pending";
import { householdToday } from "../dates";
import {
	createFromSuggestion,
	dismissSuggestion,
} from "../db/category-suggestions";
import {
	type NameChoice,
	type NameReview,
	settleSuggestion,
} from "../db/merchant-names";
import {
	NEVER_SUGGEST_KINDS,
	type NeverSuggestKind,
} from "../db/never-suggest";
import {
	categoryAskedSql,
	incomeAskedSql,
	neverSuggestAskedSql,
	type SuggestionItem,
	suggestionQueue,
	transferAskedSql,
} from "../db/suggestions-queue";
import { hxTrigger } from "../htmx";
import { tidyName } from "../transactions/tidy-name";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import {
	MAX_OWN_NAME,
	OWN_VALUE,
	pickValue,
	STORE_VALUE,
} from "../views/name-choices";
import {
	AskFirst,
	joinStores,
	SuggestionCard,
} from "../views/suggestion-review";

type App = { Bindings: Env };

const PATH = "/settings/suggestions";
const MAX_STORE_KEY = 500;

/** A question the No just raised: its store(s) and what the check says (decision 101). */
type Ask = {
	kind: "income" | "transfer" | "new_category";
	id: string;
	name?: string;
	stores: { merchantKey: string; label: string }[];
	check?: string;
};

/** What the form held when it was posted, shown again with its error. */
type Values = {
	id: string;
	picked?: string | null;
	own?: string;
	ticked?: number[];
};

export const suggestions = new Hono<App>();

/**
 * The address of the screen with its skips in it, so every form keeps the skips it was drawn with. `skip`
 * holds the items set aside; `again` holds those set aside a second time, after they came back (decision 79).
 */
export function reviewAddress(skipped: string[], again: string[] = []): string {
	const query = new URLSearchParams();
	for (const id of skipped) query.append("skip", id);
	for (const id of again) query.append("again", id);
	return query.size ? `${PATH}?${query}` : PATH;
}

/** The skip keys of one address key, kept only when the queue still has them (never bank text). */
function requestedKeys(
	url: string,
	key: "skip" | "again",
	ids: Set<string>,
): string[] {
	const requested = new URL(url).searchParams.getAll(key);
	return [...new Set(requested)].filter((id) => ids.has(id));
}

/** What the address says about the review: the items set aside, and those set aside again. */
function requestedReview(
	url: string,
	queue: SuggestionItem[],
): { skipped: string[]; again: string[] } {
	const ids = new Set(queue.map((item) => item.id));
	const skipped = requestedKeys(url, "skip", ids);
	const skippedSet = new Set(skipped);
	return {
		skipped,
		again: requestedKeys(url, "again", ids).filter((id) => skippedSet.has(id)),
	};
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
				{/* The question has no count: the item it asks about has just left the queue, so "0 left" would read wrong. */}
				{ask ? (
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
	} = {},
) {
	const db = c.env.DB;
	const queue = await suggestionQueue(db);
	const { skipped, again } = requestedReview(c.req.url, queue);
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
			address={addressOf(c)}
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
			}}
		/>,
		options.status ?? 200,
	);
}

/** What the announcer says after an answer: how many are left to check. */
const left = (queue: SuggestionItem[]) =>
	queue.length === 0
		? "Nothing left to check."
		: `${queue.length} left to check.`;

// Settings → Suggestions (issue #195, decision 101): one item at a time, like Organize.
suggestions.get(PATH, (c) => renderScreen(c));

// The names review it replaces: its address goes to the screen (the names it held are in the queue now).
suggestions.get("/settings/names", (c) => c.redirect(PATH, 303));
suggestions.post("/settings/names", (c) => c.redirect(PATH, 303));

suggestions.post(PATH, async (c) => {
	const db = c.env.DB;
	const form = await c.req.formData();
	const answer = form.get("answer")?.toString() ?? "";
	const id = form.get("id")?.toString() ?? "";
	const who = actor(c as Context<App> & { env: Env & { DEMO: string } });
	const today = await householdToday(db);
	const queue = await suggestionQueue(db);
	const { skipped, again } = requestedReview(c.req.url, queue);
	const next = reviewAddress(skipped, again);
	// `extra` is one more sentence for the announcer, such as what a create left out; the toast keeps its words.
	const done = (message: string, queueAfter: SuggestionItem[], extra = "") => {
		if (!c.req.header("HX-Request")) return c.redirect(next, 303);
		return renderScreen(c, {
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
					.filter((store) => store.length > 0 && store.length <= MAX_STORE_KEY),
			),
		];
		if (
			!NEVER_SUGGEST_KINDS.includes(kind as NeverSuggestKind) ||
			stores.length === 0
		)
			return stale();
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
		const { results } = await db
			.prepare(
				`INSERT OR IGNORE INTO never_suggest_rules (merchant_key, kind, decided_on)
				SELECT q.key, ?2, ?3 FROM (${neverSuggestAskedSql(kind as NeverSuggestKind)}) q
				WHERE q.key IN (SELECT value FROM json_each(?4)) RETURNING merchant_key`,
			)
			.bind(Number(found[2]), kind, today, JSON.stringify(stores))
			.all<{ merchant_key: string }>();
		const written = new Set(results.map((row) => row.merchant_key));
		const known = stores.filter((store) => written.has(store));
		if (known.length === 0) return stale();
		// The line hides the store's other items, so the count is taken once it is written.
		const after = await suggestionQueue(db);
		const labels = joinStores([...(await storeLabels(db, known)).values()]);
		const message =
			kind === "income"
				? `Got it. Tally won't suggest income for ${labels} again. Change it in Settings.`
				: kind === "transfer"
					? `Got it. Tally won't suggest a transfer for ${labels} again. Change it in Settings.`
					: `Got it. Tally won't suggest a new category for ${labels} again. Change it in Settings.`;
		return done(message, after);
	}

	const item = queue.find((candidate) => candidate.id === id);
	if (!item) return stale();

	switch (item.kind) {
		case "income": {
			if (answer === "yes") {
				const result = await db
					.prepare(
						`UPDATE transactions SET flag_income = 1, income_source = 'user', income_confidence = NULL,
							updated_by = ?, updated_at = datetime('now')
						WHERE id = ? AND ${incomeAskedSql("transactions")}`,
					)
					.bind(who, item.transactionId)
					.run();
				if (result.meta.changes === 0) return stale();
				const after = await suggestionQueue(db);
				return done(`Counted ${item.label} as income.`, after);
			}
			// A No changes nothing that counts: it hides this one Maybe (decision 101), and the question asks first.
			if (answer === "no") {
				const result = await db
					.prepare(
						`UPDATE transactions SET income_maybe_declined = 1
						WHERE id = ? AND ${incomeAskedSql("transactions")}`,
					)
					.bind(item.transactionId)
					.run();
				if (result.meta.changes === 0) return stale();
				return askScreen(c, {
					kind: "income",
					id: item.id,
					stores: [{ merchantKey: item.merchantKey, label: item.merchant }],
					check: "Not counted as income",
				});
			}
			break;
		}
		case "transfer": {
			if (answer === "yes") {
				const result = await db
					.prepare(
						`UPDATE transactions SET excluded = 1, excluded_source = 'user', transfer_confidence = NULL,
							updated_by = ?, updated_at = datetime('now')
						WHERE id = ? AND ${transferAskedSql("transactions")}`,
					)
					.bind(who, item.transactionId)
					.run();
				if (result.meta.changes === 0) return stale();
				const after = await suggestionQueue(db);
				return done(`Left ${item.label} out of the budget.`, after);
			}
			// A No changes nothing that counts: it hides this one Maybe (decision 101), and the question asks first.
			if (answer === "no") {
				const result = await db
					.prepare(
						`UPDATE transactions SET transfer_maybe_declined = 1
						WHERE id = ? AND ${transferAskedSql("transactions")}`,
					)
					.bind(item.transactionId)
					.run();
				if (result.meta.changes === 0) return stale();
				return askScreen(c, {
					kind: "transfer",
					id: item.id,
					stores: [{ merchantKey: item.merchantKey, label: item.merchant }],
					check: "Kept in the budget",
				});
			}
			break;
		}
		case "category": {
			if (answer === "yes") {
				const result = await db
					.prepare(
						`UPDATE transactions SET category_id = jev_category_id, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL,
							updated_by = ?, updated_at = datetime('now')
						WHERE id = ? AND jev_category_id = ? AND ${categoryAskedSql("transactions")}`,
					)
					.bind(who, item.transactionId, item.categoryId)
					.run();
				if (result.meta.changes === 0) return stale();
				const after = await suggestionQueue(db);
				return done(`Set ${item.label} to ${item.category}.`, after);
			}
			if (answer === "else") {
				const chosen = Number(form.get("category")?.toString() ?? "");
				const category = Number.isInteger(chosen)
					? await db
							.prepare(
								"SELECT id, name FROM categories WHERE id = ? AND archived = 0",
							)
							.bind(chosen)
							.first<{ id: number; name: string }>()
					: null;
				if (!category)
					return renderScreen(c, {
						values: { id },
						error: "Pick a category.",
						status: 422,
						focus: true,
					});
				const result = await db
					.prepare(
						`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL, split_removed_bills = NULL,
							updated_by = ?, updated_at = datetime('now')
						WHERE id = ? AND ${categoryAskedSql("transactions")}
							AND EXISTS (SELECT 1 FROM categories cc WHERE cc.id = ? AND cc.archived = 0)`,
					)
					.bind(category.id, who, item.transactionId, category.id)
					.run();
				if (result.meta.changes === 0) return stale();
				const after = await suggestionQueue(db);
				return done(`Set ${item.label} to ${category.name}.`, after);
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
				const result = await createFromSuggestion(
					db,
					item.suggestionId,
					{ ticked, shown, notes: {} },
					who,
				);
				if (!result.ok) {
					if (result.reason === "gone") return stale();
					return renderScreen(c, {
						values: { id, ticked },
						error:
							result.error ??
							"Tick at least one transaction, or dismiss this suggestion.",
						status: 422,
						focus: true,
					});
				}
				await askAgainLeftOut(
					c.env as Env & { JEV_API_KEY?: string },
					result.leftOut,
					(work) => c.executionCtx.waitUntil(work),
				);
				const after = await suggestionQueue(db);
				const message = result.restored
					? `Restored ${result.name} with ${result.moved} ${result.moved === 1 ? "transaction" : "transactions"}.`
					: result.attached
						? `Added ${result.moved} ${result.moved === 1 ? "transaction" : "transactions"} to ${result.name}.`
						: `Made ${result.name} with ${result.moved} ${result.moved === 1 ? "transaction" : "transactions"}.`;
				return done(message, after, leftOutSentence(result.leftOut.length));
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
		if (own.length > MAX_OWN_NAME)
			return {
				ok: false,
				error: `Keep the name under ${MAX_OWN_NAME} characters.`,
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

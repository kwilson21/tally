import { type Context, Hono } from "hono";
import { actor } from "../actor";
import { householdToday } from "../dates";
import {
	createFromSuggestion,
	dismissSuggestion,
} from "../db/category-suggestions";
import { type NameChoice, settleSuggestion } from "../db/merchant-names";
import { addNeverSuggest, type NeverSuggestKind } from "../db/never-suggest";
import { type SuggestionItem, suggestionQueue } from "../db/suggestions-queue";
import { tidyName } from "../transactions/tidy-name";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import { KEEP_VALUE, MAX_OWN_NAME, pickValue } from "../views/name-choices";
import {
	AskFirst,
	joinStores,
	SuggestionCard,
} from "../views/suggestion-review";

type App = { Bindings: Env };

const PATH = "/settings/suggestions";
const ANSWER_KINDS: NeverSuggestKind[] = ["income", "transfer", "new_category"];
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
type Values = { id: string };

export const suggestions = new Hono<App>();

/** The address of the screen with the skipped items in it, so every form keeps the skips it was drawn with. */
export function reviewAddress(skipped: string[]): string {
	const query = new URLSearchParams();
	for (const id of skipped) query.append("skip", id);
	return query.size ? `${PATH}?${query}` : PATH;
}

/** The skip keys in an address, kept only when the queue still has them (never bank text). */
function requestedSkips(url: string, ids: Set<string>): string[] {
	const requested = new URL(url).searchParams.getAll("skip");
	return [...new Set(requested)].filter((id) => ids.has(id));
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
	queue: SuggestionItem[];
	ask?: Ask;
	values?: Values;
	error?: string;
	focus?: boolean;
	today: string;
	categories: { id: number; name: string }[];
};

function Screen({ input, demo }: { input: ScreenInput; demo: boolean }) {
	const { skipped, queue, ask, values, error, focus = false, today } = input;
	const skippedSet = new Set(skipped);
	const available = queue.filter((item) => !skippedSet.has(item.id));
	const current =
		(values && queue.find((item) => item.id === values.id)) || available[0];
	const position = skipped.length + 1;
	const total = queue.length;
	// Every form posts to this screen's address, so the skips it was drawn with carry over.
	const action = reviewAddress(skipped);
	return (
		<Layout title="Suggestions · Tally" active="settings" demo={demo}>
			<div id="suggestions-page" class="lg:max-w-3xl">
				<a
					href="/settings"
					class="inline-flex min-h-11 items-center text-accent"
				>
					Settings
				</a>
				{ask ? (
					<>
						<p class="mt-2 text-muted">Suggestions · {total} left</p>
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
					</>
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
								skipHref={reviewAddress([...skipped, current.id])}
								error={error}
								focus={focus}
							/>
						</div>
					</>
				) : skipped.length > 0 ? (
					<div class="mt-2">
						<EmptyState
							kind="done"
							sentence="You skipped the rest."
							action={{ href: PATH, label: "Start over" }}
						/>
					</div>
				) : (
					<div class="mt-2">
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
	const ids = new Set(queue.map((item) => item.id));
	const skipped = requestedSkips(c.req.url, ids);
	const categories = await db
		.prepare(
			"SELECT id, name FROM categories WHERE archived = 0 ORDER BY sort_order, name",
		)
		.all<{ id: number; name: string }>();
	if (options.toast) {
		c.header(
			"HX-Trigger",
			JSON.stringify({
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
			input={{
				skipped,
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
	const ids = new Set(queue.map((item) => item.id));
	const skipped = requestedSkips(c.req.url, ids);
	const next = reviewAddress(skipped);
	const done = (message: string, queueAfter: SuggestionItem[]) => {
		if (!c.req.header("HX-Request")) return c.redirect(next, 303);
		return renderScreen(c, {
			focus: true,
			toast: {
				message,
				type: "success",
				announce: `${message.replace(/\.$/, "")}. ${left(queueAfter)}`,
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
		const stores = form
			.getAll("store")
			.map((store) => store.toString())
			.filter((store) => store.length > 0 && store.length <= MAX_STORE_KEY);
		if (!ANSWER_KINDS.includes(kind as NeverSuggestKind) || stores.length === 0)
			return stale();
		if (answer === "ask_not_now") {
			const message = "Kept it as it is.";
			if (!c.req.header("HX-Request")) return c.redirect(next, 303);
			return renderScreen(c, {
				focus: true,
				toast: { message, type: "info", announce: `${message} ${left(queue)}` },
			});
		}
		for (const merchantKey of stores)
			await addNeverSuggest(db, {
				merchantKey,
				kind: kind as NeverSuggestKind,
				decidedOn: today,
			});
		// The line hides the store's other items, so the count is taken once it is written.
		const after = await suggestionQueue(db);
		const labels = joinStores([...(await storeLabels(db, stores)).values()]);
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
						WHERE id = ? AND flag_income = 0 AND amount_cents < 0 AND refund_of_id IS NULL`,
					)
					.bind(who, item.transactionId)
					.run();
				if (result.meta.changes === 0) return stale();
				const after = await suggestionQueue(db);
				return done(`Counted ${item.merchant} as income.`, after);
			}
			if (answer === "no") {
				const result = await db
					.prepare(
						`UPDATE transactions SET credit_reviewed = 1, credit_reviewed_by = 'user', income_confidence = NULL,
							updated_by = ?, updated_at = datetime('now')
						WHERE id = ? AND flag_income = 0 AND amount_cents < 0 AND refund_of_id IS NULL`,
					)
					.bind(who, item.transactionId)
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
						WHERE id = ? AND excluded = 0 AND refund_of_id IS NULL`,
					)
					.bind(who, item.transactionId)
					.run();
				if (result.meta.changes === 0) return stale();
				const after = await suggestionQueue(db);
				return done(`Left ${item.merchant} out of the budget.`, after);
			}
			if (answer === "no") {
				const result = await db
					.prepare(
						`UPDATE transactions SET excluded = 0, excluded_source = 'user', transfer_confidence = NULL,
							updated_by = ?, updated_at = datetime('now')
						WHERE id = ? AND excluded = 0 AND COALESCE(excluded_source, '') != 'user' AND refund_of_id IS NULL`,
					)
					.bind(who, item.transactionId)
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
						`UPDATE transactions SET category_id = jev_category_id, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL,
							updated_by = ?, updated_at = datetime('now')
						WHERE id = ? AND category_id IS NULL AND category_source IS NULL AND jev_category_id IS NOT NULL
							AND EXISTS (SELECT 1 FROM categories c WHERE c.id = transactions.jev_category_id AND c.archived = 0)`,
					)
					.bind(who, item.transactionId)
					.run();
				if (result.meta.changes === 0) return stale();
				const after = await suggestionQueue(db);
				return done(`Set ${item.merchant} to ${item.category}.`, after);
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
						`UPDATE transactions SET category_id = ?, category_source = 'user', category_confidence = NULL, split_removed_from_cents = NULL,
							updated_by = ?, updated_at = datetime('now')
						WHERE id = ? AND category_id IS NULL AND category_source IS NULL`,
					)
					.bind(category.id, who, item.transactionId)
					.run();
				if (result.meta.changes === 0) return stale();
				const after = await suggestionQueue(db);
				return done(`Set ${item.merchant} to ${category.name}.`, after);
			}
			break;
		}
		case "new_category": {
			if (answer === "yes") {
				const shown = form
					.getAll("shown")
					.map((value) => Number(value.toString()))
					.filter((n) => Number.isInteger(n) && n > 0);
				const ticked = form
					.getAll("ticked")
					.map((value) => Number(value.toString()))
					.filter((n) => Number.isInteger(n) && n > 0);
				const result = await createFromSuggestion(
					db,
					item.suggestionId,
					{ ticked, shown, notes: {} },
					who,
				);
				if (!result.ok) {
					if (result.reason === "gone") return stale();
					return renderScreen(c, {
						values: { id },
						error:
							result.error ??
							"Tick at least one transaction, or dismiss this suggestion.",
						status: 422,
						focus: true,
					});
				}
				const after = await suggestionQueue(db);
				const message = result.attached
					? `Added ${result.moved} ${result.moved === 1 ? "transaction" : "transactions"} to ${result.name}.`
					: `Made ${result.name} with ${result.moved} ${result.moved === 1 ? "transaction" : "transactions"}.`;
				return done(message, after);
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
			if (answer === "yes") {
				const settled = await settleSuggestion(db, item.merchantKey, {
					kind: "name",
					name: review.names[0] ?? review.tidied,
				});
				if (!settled) return stale();
				const after = await suggestionQueue(db);
				return done(
					`Renamed ${review.count} ${review.count === 1 ? "transaction" : "transactions"} to ${review.names[0] ?? review.tidied}`,
					after,
				);
			}
			if (answer === "else") {
				const choice = readChoice(
					item,
					form.get("name_pick")?.toString() ?? null,
					form.get("merchant")?.toString().trim() ?? "",
				);
				if (!choice.ok)
					return renderScreen(c, {
						values: { id },
						error: choice.error,
						status: 422,
						focus: true,
					});
				const settled = await settleSuggestion(
					db,
					item.merchantKey,
					choice.value,
				);
				if (!settled) return stale();
				const after = await suggestionQueue(db);
				const count = review.count;
				const transactions = count === 1 ? "transaction" : "transactions";
				const message =
					choice.value.kind === "keep"
						? `Kept the bank's name for ${count} ${transactions}`
						: `Renamed ${count} ${transactions} to ${choice.value.name}`;
				return done(message, after);
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

/** What a person chose for a name: a typed name first, then a chip, which must be one of the names shown. */
function readChoice(
	item: Extract<SuggestionItem, { kind: "name" }>,
	picked: string | null,
	own: string,
): { ok: true; value: NameChoice } | { ok: false; error: string } {
	if (own.length > MAX_OWN_NAME)
		return {
			ok: false,
			error: `Keep the name under ${MAX_OWN_NAME} characters.`,
		};
	if (own) return { ok: true, value: { kind: "name", name: own } };
	if (picked === KEEP_VALUE) return { ok: true, value: { kind: "keep" } };
	const name = item.review.names.find((n) => pickValue(n) === picked);
	if (name) return { ok: true, value: { kind: "name", name } };
	return {
		ok: false,
		error: picked
			? "Pick one of the names shown."
			: "Pick a name, keep the bank's, or type your own.",
	};
}

import { type Context, Hono } from "hono";
import {
	type NameChoice,
	type NameReview,
	namesToReview,
	settleSuggestion,
} from "../db/merchant-names";
import { Button } from "../views/button";
import { EmptyState } from "../views/empty-state";
import { Layout } from "../views/layout";
import {
	KEEP_VALUE,
	MAX_OWN_NAME,
	NameChoices,
	pickValue,
} from "../views/name-choices";

type App = { Bindings: Env };

/** What the form held when it was posted, shown again with its error. */
type Values = { key: string; picked: string | null; own: string };

export const merchantNames = new Hono<App>();

const transactions = (n: number) => (n === 1 ? "transaction" : "transactions");

async function renderReview(
	c: Context<App>,
	{
		values,
		error,
		status = 200,
		focus = false,
		toast,
	}: {
		values?: Values;
		error?: string;
		status?: 200 | 422;
		focus?: boolean;
		toast?: { message: string; type: "success" | "info"; announce: string };
	} = {},
) {
	const all = await namesToReview(c.env.DB);
	// Skip names a merchant by its row's number, never by its bank text, which would end up in the history.
	const requestedSkips = new URL(c.req.url).searchParams.getAll("skip");
	const ids = new Set(all.map((review) => String(review.id)));
	const skipped = [...new Set(requestedSkips)].filter((id) => ids.has(id));
	const available = all.filter(
		(review) => !skipped.includes(String(review.id)),
	);
	// After an error the same merchant comes back, with what was typed; otherwise the first one not skipped.
	const review: NameReview | undefined =
		(values && all.find((item) => item.key === values.key)) || available[0];

	const query = new URLSearchParams();
	for (const id of skipped) query.append("skip", id);
	const action = `/settings/names${query.size ? `?${query}` : ""}`;
	const skipQuery = new URLSearchParams(query);
	if (review) skipQuery.append("skip", String(review.id));

	if (toast) {
		c.header(
			"HX-Trigger",
			JSON.stringify({
				toast: { message: toast.message, type: toast.type },
				announce: toast.announce,
			}),
		);
	}

	return c.html(
		<Layout
			title="Merchant names · Tally"
			active="settings"
			demo={c.env.DEMO === "true"}
		>
			<div id="names-page" class="lg:max-w-3xl">
				<a
					href="/settings"
					class="inline-flex min-h-11 items-center text-accent"
				>
					Settings
				</a>
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					Merchant names
				</h1>
				{review ? (
					<>
						<p class="mt-2 text-muted">
							{skipped.length + 1} of {all.length} · {review.count}{" "}
							{transactions(review.count)}
						</p>
						<p class="mt-4 text-sm text-muted">The bank says</p>
						<h2
							class="mb-4 text-lg font-normal outline-none"
							tabindex={focus ? -1 : undefined}
							autofocus={focus}
						>
							{review.bankText}
						</h2>
						<form
							method="post"
							action={action}
							hx-post={action}
							hx-target="#names-page"
							hx-select="#names-page"
							hx-swap="outerHTML"
							hx-push-url={action}
							class="flex flex-col gap-4"
						>
							<input type="hidden" name="key" value={review.key} />
							<NameChoices
								id="review"
								names={review.names}
								source={review.source}
								tidied={review.tidied}
								count={review.count}
								picked={values?.key === review.key ? values.picked : null}
								own={values?.key === review.key ? values.own : ""}
								error={error}
							/>
							<div class="mt-2 grid grid-cols-2 gap-3">
								<Button
									kind="secondary"
									href={`/settings/names?${skipQuery}`}
									class="w-full"
								>
									Skip
								</Button>
								<Button type="submit" class="w-full" busyLabel="Saving…">
									Save and next
								</Button>
							</div>
						</form>
					</>
				) : all.length > 0 ? (
					<EmptyState
						kind="done"
						sentence="You skipped the rest."
						action={{ href: "/settings/names", label: "Start over" }}
					/>
				) : (
					<EmptyState
						kind="done"
						sentence="No merchant names to check."
						hint="Suggested names show up here as new merchants arrive."
						action={{ href: "/settings", label: "Back to Settings" }}
					/>
				)}
			</div>
		</Layout>,
		status,
	);
}

// More → Settings → Merchant names (P29 A, decision 64): one merchant with suggested names at a time.
// ?skip=<row number> (repeated) moves past the merchants a person skipped, without changing them.
merchantNames.get("/settings/names", (c) => renderReview(c));

merchantNames.post("/settings/names", async (c) => {
	const form = await c.req.formData();
	const key = form.get("key")?.toString() ?? "";
	const picked = form.get("name_pick")?.toString() ?? null;
	const own = form.get("merchant")?.toString().trim() ?? "";
	const url = new URL(c.req.url);
	const next = url.pathname + url.search;
	const review = (await namesToReview(c.env.DB)).find((r) => r.key === key);

	// Someone else named it already (another tab, the edit panel): show the next one with a fresh form,
	// so the stale choice can't carry over to it.
	if (!review) return stale(c, next);

	const choice = readChoice(review, picked, own);
	if (!choice.ok)
		return renderReview(c, {
			values: { key, picked, own },
			error: choice.error,
			status: 422,
		});
	if (!(await settleSuggestion(c.env.DB, key, choice.value)))
		return stale(c, next);

	const left = (await namesToReview(c.env.DB)).length;
	const message =
		choice.value.kind === "keep"
			? `Kept the bank's name for ${review.count} ${transactions(review.count)}`
			: `Renamed ${review.count} ${transactions(review.count)} to ${choice.value.name}`;
	if (!c.req.header("HX-Request")) return c.redirect(next, 303);
	return renderReview(c, {
		focus: true,
		toast: {
			message,
			type: "success",
			announce: `${message}. ${left} left to check.`,
		},
	});
});

function stale(c: Context<App>, next: string) {
	if (!c.req.header("HX-Request")) return c.redirect(next, 303);
	const message = "That merchant was already named.";
	return renderReview(c, {
		focus: true,
		toast: { message, type: "info", announce: message },
	});
}

/** What a person chose: a typed name first, then a chip, which must be one of the names the form showed. */
function readChoice(
	review: NameReview,
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
	const name = review.names.find((n) => pickValue(n) === picked);
	if (name) return { ok: true, value: { kind: "name", name } };
	return {
		ok: false,
		error: picked
			? "Pick one of the names shown."
			: "Pick a name, keep the bank's, or type your own.",
	};
}

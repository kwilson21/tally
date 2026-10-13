import { shortDay } from "../dates";
import {
	type NeverSuggestRule,
	neverSuggestRuleLine,
} from "../db/never-suggest";
import { Button } from "./button";
import { CategoryIcon } from "./category";
import { EmptyState } from "./empty-state";

export const MERCHANT_RULE_SEARCH_THRESHOLD = 20;

export type MerchantRule = {
	merchantKey: string;
	merchant: string;
	categoryId: number;
	category: string;
	icon: string;
	color: string;
	archived: boolean;
	transactions: number;
};

/** The shared Settings heading and its Always list, with a GET search and one Remove form per rule. */
export function MerchantRules({
	id = "merchant-rules",
	rules,
	total,
	search = "",
	focusRuleIndex,
	focusHeading,
	error,
	neverRules = [],
	neverFocus,
	today,
}: {
	id?: string;
	rules: MerchantRule[];
	/** The "Never suggest" lines, under the same heading (issue #195). */
	neverRules?: NeverSuggestRule[];
	/** Where focus goes after a "Never suggest" Remove (issue #195). */
	neverFocus?: NeverSuggestFocus;
	/** The household's today, for the year on a No's day. */
	today: string;
	total: number;
	search?: string;
	focusRuleIndex?: number;
	focusHeading?: boolean;
	error?: string;
}) {
	const count = search
		? `${rules.length} merchants matching “${search}”`
		: `${total} merchants, A to Z`;
	return (
		<section id={id} aria-labelledby={`${id}-title`} class="mt-8 lg:max-w-3xl">
			<h2
				id={`${id}-title`}
				tabindex={focusHeading ? -1 : undefined}
				autofocus={focusHeading || undefined}
				class="font-serif text-3xl font-semibold"
			>
				Tally's rules
			</h2>
			<p class="mt-1 text-muted">
				What Tally does on its own, and what it won't suggest.
			</p>
			{error && (
				<p role="alert" class="mt-3 text-sm text-over">
					{error}
				</p>
			)}
			<div class="mt-5">
				<h3 class="text-xl font-semibold">Always for these merchants</h3>
				{total > MERCHANT_RULE_SEARCH_THRESHOLD && (
					<form
						method="get"
						action="/settings"
						class="mt-3 flex flex-col gap-2 sm:flex-row"
						hx-get="/settings"
						hx-trigger="input delay:300ms, submit"
						hx-sync="replace"
						hx-target={`#${id}-results`}
						hx-select={`#${id}-results`}
						hx-select-oob={`#${id}-count:innerHTML`}
						hx-swap="outerHTML"
						hx-push-url="true"
					>
						<label class="sr-only" for={`${id}-search`}>
							Search merchants
						</label>
						<input
							id={`${id}-search`}
							class="min-h-11 min-w-0 flex-1 rounded-control border border-rule bg-paper px-3 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
							name="rules_search"
							value={search}
							placeholder="Search merchants"
							autocomplete="off"
						/>
						<Button type="submit" kind="secondary">
							Search
						</Button>
					</form>
				)}
				<p
					id={`${id}-count`}
					class="mt-2 text-sm text-muted"
					aria-live="polite"
					aria-atomic="true"
				>
					{count}
				</p>
				<div id={`${id}-results`}>
					{rules.length === 0 ? (
						<EmptyState
							kind={search ? "search" : "done"}
							sentence={
								search
									? `No merchants match “${search}”.`
									: "No merchants have an Always rule yet."
							}
						/>
					) : (
						<ul class="mt-2 divide-y divide-rule border-y border-rule">
							{rules.map((rule, index) => (
								<li class="flex min-h-16 items-center gap-4 py-2">
									<CategoryIcon icon={rule.icon} color={rule.color} />
									<span class="min-w-0 flex-1">
										<span class="block text-lg leading-6">
											{rule.merchant}{" "}
											<span class="whitespace-nowrap">
												<span aria-hidden="true">→ </span>
												<span class="sr-only">is always </span>
												{rule.category}
											</span>
										</span>
										<span class="block leading-6 text-muted">
											Always {rule.category} · {rule.transactions}{" "}
											{rule.transactions === 1 ? "transaction" : "transactions"}
										</span>
										{rule.archived && (
											<span class="block text-sm text-muted">
												Paused while {rule.category} is archived
											</span>
										)}
									</span>
									<form
										method="post"
										action="/settings/merchant-rules/remove"
										hx-post="/settings/merchant-rules/remove"
										hx-target={`#${id}`}
										hx-select={`#${id}`}
										hx-swap="outerHTML"
									>
										<input
											type="hidden"
											name="merchant"
											value={rule.merchantKey}
										/>
										{search && (
											<input type="hidden" name="rules_search" value={search} />
										)}
										<Button
											type="submit"
											kind="text"
											autofocus={focusRuleIndex === index || undefined}
										>
											Remove<span class="sr-only"> {rule.merchant}</span>
										</Button>
									</form>
								</li>
							))}
						</ul>
					)}
				</div>
			</div>
			<NeverSuggestList
				rules={neverRules}
				search={search}
				today={today}
				target={id}
				focus={neverFocus}
			/>
		</section>
	);
}

/** Where focus goes after a "Never suggest" Remove: a line's Remove by its position, or the heading. */
export type NeverSuggestFocus = { index?: number; heading?: boolean };

/**
 * The "Never suggest" list under the same heading (issue #195, decision 101): one line per No the family
 * said Yes to, the day of it, and a Remove whose name says which line it takes away. `target` is the id of
 * the section the Remove swaps (the MerchantRules section it sits in), so the swap finds it wherever it is drawn.
 */
export function NeverSuggestList({
	rules,
	search = "",
	today,
	target,
	focus = {},
}: {
	rules: NeverSuggestRule[];
	/** The Always search, kept through a Remove so the list above still shows it. */
	search?: string;
	today: string;
	/** The id of the section this list is drawn in; a Remove swaps that section. */
	target: string;
	focus?: NeverSuggestFocus;
}) {
	return (
		<div class="mt-8">
			<h3
				tabindex={focus.heading ? -1 : undefined}
				autofocus={focus.heading || undefined}
				class="text-xl font-semibold"
			>
				Never suggest
			</h3>
			{rules.length === 0 ? (
				<EmptyState kind="done" sentence="Tally hasn't been told No yet." />
			) : (
				<ul class="mt-2 divide-y divide-rule border-y border-rule">
					{rules.map((rule, index) => {
						const line = neverSuggestRuleLine(rule);
						return (
							<li class="flex min-h-16 items-center gap-4 py-2">
								<span class="min-w-0 flex-1">
									<span class="block text-lg leading-6">{line}</span>
									<span class="block leading-6 text-muted">
										You said No on {shortDay(rule.decidedOn, today)}
									</span>
								</span>
								<form
									method="post"
									action="/settings/never-suggest/remove"
									hx-post="/settings/never-suggest/remove"
									hx-disable="findAll button[type=submit]"
									hx-target={`#${target}`}
									hx-select={`#${target}`}
									// A line back in place can bring a suggestion back to the review, so the Band follows.
									hx-select-oob="#names-band"
									hx-swap="outerHTML"
								>
									<input type="hidden" name="id" value={String(rule.id)} />
									<input
										type="hidden"
										name="merchant_key"
										value={rule.merchantKey}
									/>
									<input type="hidden" name="kind" value={rule.kind} />
									{search && (
										<input type="hidden" name="rules_search" value={search} />
									)}
									<Button
										type="submit"
										kind="text"
										autofocus={focus.index === index || undefined}
									>
										Remove<span class="sr-only"> {line}</span>
									</Button>
								</form>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

import { Button } from "./button";
import { Icon } from "./icons";

export type GroupRuleOfferValue = {
	/** The group's merchant keys: Yes makes the rule on each of them. */
	merchantKeys: string[];
	/** The store's name as Organize shows it after the save. */
	merchant: string;
	categoryId: number;
	category: string;
};

/**
 * Organize's question after a group is saved (#353): the group variant of RuleOffer, with no count, since the
 * group's charges were just filed. Not now and Yes post the same form with `answer` set, so the answer reaches
 * the route in one request, with or without JavaScript. Its heading takes focus, like RuleOffer's.
 */
export function GroupRuleOffer({
	value,
	action,
	focus = false,
}: {
	value: GroupRuleOfferValue;
	/** The route that answers the question, with the skips the page carries. */
	action: string;
	focus?: boolean;
}) {
	return (
		<div class="flex flex-col gap-3">
			<p role="status" class="flex items-center gap-2 text-muted">
				<Icon name="check" class="size-5" />
				Saved as {value.category}
			</p>
			<h2
				id="rule-offer-title"
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="font-serif text-4xl font-semibold tracking-tight"
			>
				Always use {value.category} for {value.merchant}?
			</h2>
			<p>Say yes and Tally sorts the next one for you.</p>
			<form
				method="post"
				action={action}
				hx-post={action}
				hx-disable="#organize-page button[type=submit]"
				hx-sync="#organize-page:drop"
				hx-target="#organize-page"
				hx-select="#organize-page"
				hx-swap="outerHTML"
				class="grid grid-cols-2 gap-3"
			>
				<input
					type="hidden"
					name="merchant_keys"
					value={JSON.stringify(value.merchantKeys)}
				/>
				<input type="hidden" name="merchant" value={value.merchant} />
				<input type="hidden" name="category" value={String(value.categoryId)} />
				<Button
					kind="secondary"
					type="submit"
					name="answer"
					value="no"
					class="w-full"
				>
					Not now
				</Button>
				<Button type="submit" name="answer" value="yes" class="w-full">
					Yes
				</Button>
			</form>
		</div>
	);
}

export type RuleOfferValue = {
	merchantKey: string;
	merchant: string;
	categoryId: number;
	category: string;
	count: number;
	back: string;
};

/** What the screen reader hears when the offer appears: the save's own words, then the question. */
export function ruleOfferAnnouncement(
	value: RuleOfferValue,
	lead: string,
): string {
	return `${lead} Always use ${value.category} for ${value.merchant}? You've picked ${value.category} for ${value.merchant} ${value.count} times.`;
}

/** The one yes-or-no question after a person has chosen a merchant's category three times. */
export function RuleOffer({
	value,
	focus = false,
}: {
	value: RuleOfferValue;
	focus?: boolean;
}) {
	return (
		<div class="flex flex-col gap-3">
			<p role="status" class="flex items-center gap-2 text-muted">
				<Icon name="check" class="size-5" />
				Saved as {value.category}
			</p>
			<h2
				id="rule-offer-title"
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="font-serif text-4xl font-semibold tracking-tight"
			>
				Always use {value.category} for {value.merchant}?
			</h2>
			<p>
				You've picked {value.category} for {value.merchant} {value.count} times.
				Say yes and Tally sorts the next one for you.
			</p>
			<div class="grid grid-cols-2 gap-3">
				<form
					method="post"
					action="/transactions/rule-offer/dismiss"
					hx-post="/transactions/rule-offer/dismiss"
					hx-target="#main"
					hx-select="#main > *"
					hx-swap="innerHTML"
				>
					<input type="hidden" name="merchant_key" value={value.merchantKey} />
					<input type="hidden" name="merchant" value={value.merchant} />
					<input
						type="hidden"
						name="category"
						value={String(value.categoryId)}
					/>
					<input type="hidden" name="count" value={String(value.count)} />
					<input type="hidden" name="back" value={value.back} />
					<Button kind="secondary" type="submit" class="w-full">
						Not now
					</Button>
				</form>
				<form
					method="post"
					action="/transactions/rule-offer"
					hx-post="/transactions/rule-offer"
					hx-target="#main"
					hx-select="#main > *"
					hx-swap="innerHTML"
				>
					<input type="hidden" name="merchant_key" value={value.merchantKey} />
					<input type="hidden" name="merchant" value={value.merchant} />
					<input
						type="hidden"
						name="category"
						value={String(value.categoryId)}
					/>
					<input type="hidden" name="count" value={String(value.count)} />
					<input type="hidden" name="back" value={value.back} />
					<Button type="submit" class="w-full">
						Yes
					</Button>
				</form>
			</div>
		</div>
	);
}

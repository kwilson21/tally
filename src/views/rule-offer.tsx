import { Button } from "./button";
import { Icon } from "./icons";

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

/**
 * The one yes-or-no question after a person has chosen a merchant's category three times. `savedId` is the
 * transaction that was saved, so both answers return focus to its row; a bulk save names none, and its answers
 * return focus to the list.
 */
export function RuleOffer({
	value,
	focus = false,
	savedId,
}: {
	value: RuleOfferValue;
	focus?: boolean;
	savedId?: number;
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
					{savedId !== undefined && (
						<input type="hidden" name="saved" value={String(savedId)} />
					)}
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
					{savedId !== undefined && (
						<input type="hidden" name="saved" value={String(savedId)} />
					)}
					<Button type="submit" class="w-full">
						Yes
					</Button>
				</form>
			</div>
		</div>
	);
}

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

/** The one yes-or-no question after a person has chosen a merchant's category three times. */
export function RuleOffer({
	value,
	focus = false,
}: {
	value: RuleOfferValue;
	focus?: boolean;
}) {
	return (
		<section
			class="mt-5 border-t border-rule pt-4"
			aria-labelledby="rule-offer-title"
		>
			<p role="status" class="flex items-center gap-2 text-sm text-muted">
				<Icon name="check" class="size-5" />
				Saved as {value.category}
			</p>
			<h3
				id="rule-offer-title"
				tabindex={focus ? -1 : undefined}
				autofocus={focus || undefined}
				class="font-serif text-4xl font-semibold tracking-tight"
			>
				Always use {value.category} for {value.merchant}?
			</h3>
			<p class="mt-2 text-muted">
				You've picked {value.category} for {value.merchant} {value.count} times.
				Say yes and Tally sorts the next one for you.
			</p>
			<div class="mt-4 grid grid-cols-2 gap-3">
				<form
					method="post"
					action="/transactions/rule-offer/dismiss"
					hx-post="/transactions/rule-offer/dismiss"
					hx-target="#page"
					hx-select="#page"
					hx-swap="outerHTML"
				>
					<input type="hidden" name="merchant_key" value={value.merchantKey} />
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
					hx-target="#page"
					hx-select="#page"
					hx-swap="outerHTML"
				>
					<input type="hidden" name="merchant_key" value={value.merchantKey} />
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
		</section>
	);
}

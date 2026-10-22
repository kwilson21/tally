import { shortDay } from "../dates";
import { AccountRow } from "./account-row";
import { sheetAttrs } from "./bottom-sheet";
import { Button } from "./button";
import { Icon } from "./icons";

/** The Apple Card account as Accounts draws it (spec §8.10, P141 B). */
export type AppleCardView = {
	/** The card's balance in cents, as owed: positive when the family owes it, negative for a credit. AccountRow shows it as debt, negative. */
	balanceCents: number;
	/** The household day the balance was typed, or null while none counts. */
	balanceOn: string | null;
	/** The latest Clearing Date the card holds, or null before its first row. */
	through: string | null;
	/** Removed: kept out of net worth; its rows stay (Remove Apple Card, spec §8.10). */
	removed: boolean;
};

type Props = {
	card: AppleCardView;
	/** The household's today, which names the years when they differ. */
	today: string;
	/** The demo has no Manage, and its Upload adds the sample. */
	demo?: boolean;
	/** Puts focus on "Upload a file" when the group is drawn again after a cancel or an upload. */
	focusUpload?: boolean;
};

/**
 * Apple Card's group on Accounts, drawn as a bank's group is (BankGroup): its name, "Updated through …" (or "Removed"),
 * one row with the card icon and its balance, the Upload button under it and Manage holding Remove. With no balance
 * counting, the row has no amount and a line says the card isn't in net worth yet; removed, the row has no amount, and
 * there's no upload or Manage.
 */
export function AppleCardGroup({
	card,
	today,
	demo = false,
	focusUpload,
}: Props) {
	const counted = card.balanceOn !== null && !card.removed;
	return (
		<section class="mt-8" data-apple-card="">
			<h2 class="text-muted" tabindex={-1}>
				Apple Card
			</h2>
			{card.removed ? (
				<p class="mt-1 text-sm text-muted">Removed</p>
			) : (
				card.through && (
					<p class="mt-1 text-sm text-muted">
						Updated through {shortDay(card.through, today)}
					</p>
				)
			)}
			<ul class="mt-2 divide-y divide-rule border-y border-rule">
				<AccountRow
					name="Apple Card"
					mask={null}
					type="credit"
					balanceCents={counted ? card.balanceCents : null}
					isLiability
					detail={
						counted && card.balanceOn
							? `Balance as of ${shortDay(card.balanceOn, today)}`
							: undefined
					}
				/>
			</ul>
			{!card.removed && card.balanceOn === null && (
				<p class="mt-2 text-muted">
					Apple Card isn't in net worth yet. Add its balance next time you
					upload.
				</p>
			)}
			{!card.removed && (
				<Button
					kind="secondary"
					href="/accounts/apple-card"
					class="mt-3"
					autofocus={focusUpload}
					{...sheetAttrs("/accounts/apple-card")}
				>
					Upload a file
				</Button>
			)}
			{!demo && !card.removed && (
				<details class="group mt-3">
					<summary class="flex min-h-11 cursor-pointer list-none items-center gap-2 text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
						<span class="shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none">
							<Icon name="chevron-right" class="size-5" />
						</span>
						Manage
					</summary>
					<Button
						kind="secondary"
						href="/accounts/apple-card/remove"
						class="mt-2"
					>
						Remove Apple Card
					</Button>
				</details>
			)}
		</section>
	);
}

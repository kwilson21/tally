import { syncedAtLabel } from "../synced-at";
import { AccountRow } from "./account-row";
import { Button } from "./button";
import { Icon } from "./icons";

type Account = Parameters<typeof AccountRow>[0] & { id: number };

type Props = {
	/** The bank's name, as Plaid gives it. */
	name: string;
	accounts: Account[];
	/** The bank's login needs fixing (`plaid_items.status = needs_attention`). */
	needsAttention?: boolean;
	/** Extra attributes for the Fix connection button (what opens Plaid Link, #21). */
	fixAttrs?: Record<string, string>;
	/** When it last synced (null: never). Left out, as in the demo, the line isn't shown. */
	lastSyncedAt?: string | null;
	/** Fixed only by catalog/tests; the app uses the current time. */
	now?: Date;
};

/**
 * One linked bank: its name, its accounts (or, before the first sync, a line saying they're coming), and, when its login needs fixing, the reason in words with
 * an alert icon (status is never color alone) and a Fix connection button.
 */
export function BankGroup({
	name,
	accounts,
	needsAttention,
	fixAttrs,
	lastSyncedAt,
	now,
}: Props) {
	const synced =
		lastSyncedAt === undefined ? null : syncedAtLabel(lastSyncedAt, now);
	return (
		<section class="mt-8" data-bank-item-id={fixAttrs?.["data-item-id"]}>
			<h2 class="text-muted" tabindex={-1}>
				{name}
			</h2>
			{synced && <p class="mt-1 text-sm text-muted">{synced}</p>}
			{accounts.length === 0 ? (
				<p class="mt-2 text-muted">Accounts appear after the first sync.</p>
			) : (
				<ul class="mt-2 divide-y divide-rule border-y border-rule">
					{accounts.map(({ id: _, ...account }) => (
						<AccountRow {...account} />
					))}
				</ul>
			)}
			{needsAttention && (
				<>
					<p class="mt-3 flex items-center gap-2 text-over">
						<Icon name="alert" class="size-5 shrink-0" />
						Needs attention: sign in again
					</p>
					<Button
						kind="secondary"
						type="button"
						class="mt-3"
						busyLabel="Fixing…"
						{...fixAttrs}
					>
						Fix connection
					</Button>
					<div data-fix-error class="mt-3" />
				</>
			)}
		</section>
	);
}

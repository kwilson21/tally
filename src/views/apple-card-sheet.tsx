import { shortDay } from "../dates";
import { Button } from "./button";
import { FileField } from "./file-field";
import { Icon } from "./icons";
import { MoneyInput } from "./money-input";

/** The words of Apple Card's sheet (spec §8.10). The errors come from the upload's checks, never from the browser. */
export const APPLE_CARD_SHEET_TITLE = "Apple Card";

type Props = {
	/** The demo's sheet: no file and no balance, and its submit adds the sample (spec §8.10). */
	demo?: boolean;
	/** The balance as typed, kept when the upload is refused (the file input can't be refilled). */
	balance?: string;
	/** The household day of the balance that counts now, or null while none does. */
	balanceOn?: string | null;
	/** The household's today, for the balance's day. */
	today: string;
	fileError?: string;
	balanceError?: string;
	/** Which field takes focus: the file, or the balance when only it is wrong. */
	focus?: "file" | "balance";
	/** Where Cancel goes without JavaScript: the Accounts address the sheet was opened over. */
	closeHref: string;
	closeAttrs: Record<string, string>;
};

/**
 * The sheet that uploads Apple Card's file (P141 B, spec §8.10), drawn inside BottomSheet by Accounts: the card icon and
 * the title, the one-line intro, the file field, the optional balance, then Cancel and the submit, in Savings' grid.
 */
export function AppleCardSheet({
	demo = false,
	balance = "",
	balanceOn = null,
	today,
	fileError,
	balanceError,
	focus = "file",
	closeHref,
	closeAttrs,
}: Props) {
	const balanceHint =
		balanceOn === null
			? "Optional. For a credit, type a minus first."
			: `Optional. Left blank, ${shortDay(balanceOn, today)}'s balance stays. For a credit, type a minus first.`;
	return (
		<>
			<div class="flex items-center gap-3">
				<Icon name="card" class="size-7" />
				<h2
					id="apple-card-sheet-title"
					class="font-serif text-3xl font-semibold"
					tabindex={-1}
				>
					{APPLE_CARD_SHEET_TITLE}
				</h2>
			</div>
			<p class="text-muted">
				{demo
					? "In the demo, Tally uses a sample file."
					: "Upload the file Apple exports. Tally adds the ones it doesn't have yet."}
			</p>
			<form
				method="post"
				action="/accounts/apple-card"
				enctype="multipart/form-data"
				class="mt-4 flex flex-col gap-4 border-t border-rule pt-4"
				hx-post="/accounts/apple-card"
				hx-encoding="multipart/form-data"
				hx-disable="findAll button[type=submit]"
				hx-indicator="#apple-card-upload"
				hx-target="#accounts-summary"
				hx-select="#accounts-summary"
				hx-swap="outerHTML"
			>
				{!demo && (
					<>
						<FileField
							id="apple-card-file"
							name="file"
							label="Apple Card file (CSV)"
							hint="On card.apple.com or in Wallet: Export Transactions, pick the dates, then CSV."
							error={fileError}
							autofocus={focus === "file"}
						/>
						<MoneyInput
							id="apple-card-balance"
							name="balance"
							label="Balance in Wallet"
							value={balance}
							error={balanceError}
							allowCredit
							noRound
							hint={balanceHint}
							autofocus={focus === "balance"}
						/>
					</>
				)}
				<div class="mt-2 grid grid-cols-2 gap-3">
					<Button
						href={closeHref}
						kind="secondary"
						class="w-full"
						{...closeAttrs}
					>
						Cancel
					</Button>
					<Button
						id="apple-card-upload"
						type="submit"
						class="w-full"
						busyLabel={demo ? "Adding…" : "Uploading…"}
					>
						{demo ? "Add the sample" : "Upload a file"}
					</Button>
				</div>
			</form>
		</>
	);
}

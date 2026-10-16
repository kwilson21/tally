import { Button } from "./button";
import { Icon } from "./icons";
import { Switch } from "./switch";

/** The round initials' backgrounds, by list position: accent, then ok, then muted. */
const INITIAL_LOOKS = ["bg-accent", "bg-ok", "bg-muted"];

/**
 * The Bank sign-in emails block under Household (P107 "In Settings", decision 82, #606): the shared
 * Switch, the people it goes to as round initials, and a plain "Who gets them" disclosure that lists each
 * address with its Remove. The Switch saves when flipped: the form posts on change, and with htmx it swaps
 * only this block, with focus back on the Switch. A second flip replaces the first request, so the switch and
 * the toast always show the last save. Save shows only without the script (in noscript). A Remove sends its
 * address as `remove`. The route and the catalog both render it, so they can't drift apart.
 */
export function BankSignInEmails({
	on,
	recipients,
	error,
	open = false,
	focus,
	focusEmail,
	action = "/settings/bank-sign-in-emails",
}: {
	/** The saved switch: On or Off. */
	on: boolean;
	/** The addresses seen in the last 90 days, in address order. */
	recipients: string[];
	/** Why a Remove didn't happen; shown above the disclosure. */
	error?: string;
	/** The disclosure is open: it stays open after a swap, and an error opens it. */
	open?: boolean;
	/** Where focus goes after a swap: the Switch, the "Who gets them" summary, or an address's Remove. */
	focus?: "switch" | "summary" | "remove";
	/** The address whose Remove takes focus. */
	focusEmail?: string;
	action?: string;
}) {
	return (
		<div id="household-emails">
			<form
				method="post"
				action={action}
				hx-post={action}
				hx-trigger="change, submit"
				hx-sync="replace"
				hx-target="#household-emails"
				hx-select="#household-emails"
				hx-swap="outerHTML"
			>
				<Switch
					id="bank-sign-in-emails"
					name="enabled"
					label="Bank sign-in emails"
					checked={on}
					autofocus={focus === "switch"}
				/>
				{recipients.length > 0 && (
					<div class="flex items-center gap-2 pb-1">
						<p class="sr-only">Goes to {recipients.join(", ")}</p>
						<ul aria-hidden="true" class="flex -space-x-2">
							{recipients.map((email, index) => (
								<li
									class={`flex size-8 items-center justify-center rounded-full border-2 border-paper text-sm font-semibold text-paper ${INITIAL_LOOKS[index % INITIAL_LOOKS.length]}`}
								>
									{email.charAt(0).toUpperCase()}
								</li>
							))}
						</ul>
					</div>
				)}
				{error && (
					<p role="alert" class="mt-3 text-sm text-over">
						{error}
					</p>
				)}
				<details class="group pb-3" open={open}>
					<summary
						class="flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 text-accent [&::-webkit-details-marker]:hidden"
						autofocus={focus === "summary"}
					>
						<span class="min-w-0 flex-1">Who gets them</span>
						<Icon
							name="chevron-right"
							class="size-5 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
						/>
					</summary>
					<p class="text-muted">
						Everyone who has signed in to Tally in the last 90 days.
					</p>
					{recipients.length > 0 && (
						<ul class="divide-y divide-rule border-y border-rule">
							{recipients.map((email) => (
								<li class="flex min-h-11 items-center gap-3">
									<span class="min-w-0 flex-1 truncate">{email}</span>
									<Button
										kind="text"
										type="submit"
										name="remove"
										value={email}
										class="shrink-0"
										autofocus={focus === "remove" && email === focusEmail}
									>
										Remove<span class="sr-only"> {email}</span>
									</Button>
								</li>
							))}
						</ul>
					)}
				</details>
				<noscript>
					<div class="pb-4">
						<Button type="submit">Save</Button>
					</div>
				</noscript>
			</form>
		</div>
	);
}

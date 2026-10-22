import { Button } from "./button";
import { Chip } from "./chip";

/** Remove Apple Card's address: its form posts here (spec §8.10). */
const APPLE_CARD_REMOVE_PATH = "/accounts/apple-card/remove";

type Props = {
	/** Prefixes the ids of the delete hint and the chip's description; the catalog gives each state its own. */
	id?: string;
	/** The card's transactions a person can see, which say how many stay. */
	count: number;
	/** The delete box, ticked: the card's transactions go with it. */
	deleteHistory?: boolean;
	/** A failed remove, drawn again in role=alert above the form. */
	error?: string;
};

/**
 * Remove Apple Card's page body (spec §8.10), as Disconnect's page is: the heading, one sentence on how many transactions
 * stay, a failure in role=alert, then the form with its delete box, Remove and Cancel. The route wraps it in Layout; the
 * catalog draws it inside an inert box. With htmx the form swaps Accounts' `#main` in place.
 */
export function AppleCardRemove({
	id = "apple-card-remove",
	count,
	deleteHistory = false,
	error,
}: Props) {
	return (
		<>
			<h1 class="font-serif text-4xl font-semibold tracking-tight">
				Remove Apple Card?
			</h1>
			<p class="mt-4 max-w-xl text-muted">
				Tally leaves it out of net worth. Its {count}{" "}
				{count === 1 ? "transaction stays" : "transactions stay"}, so past
				months still add up, unless you tick the box below.
			</p>
			{error && (
				<p role="alert" class="mt-4 text-over">
					{error}
				</p>
			)}
			{/* htmx swaps Accounts in with a toast; without JavaScript it posts and is redirected there. */}
			<form
				method="post"
				action={APPLE_CARD_REMOVE_PATH}
				class="mt-8"
				hx-post={APPLE_CARD_REMOVE_PATH}
				hx-disable="findAll button[type=submit]"
				hx-target="#main"
				hx-select="#main"
				hx-swap="outerHTML"
			>
				<Chip
					type="checkbox"
					name="delete"
					value="yes"
					checked={deleteHistory}
					describedBy={`${id}-delete-hint`}
				>
					Also delete its transactions
				</Chip>
				<p id={`${id}-delete-hint`} class="mt-2 text-muted">
					This deletes them for good.
				</p>
				<div class="mt-6 flex items-center gap-3">
					<Button type="submit">Remove</Button>
					<Button kind="text" href="/accounts">
						Cancel
					</Button>
				</div>
			</form>
		</>
	);
}

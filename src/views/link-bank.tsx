import { Button } from "./button";

/**
 * Link a bank and its alert region: the one button that opens Plaid Link (public/js/plaid-link.js), and the region its
 * errors go to. Accounts' pair lives inside #accounts-summary, so a refresh redraws it in place. `refresh` and `target`
 * say what Plaid Link's success redraws, the page's URL and the element it swaps in (Accounts uses its defaults; Home
 * redraws its own #page, decision 114).
 */
/** The Link a bank button: it opens Plaid Link (public/js/plaid-link.js). */
export const LinkBankButton = ({
	class: layout,
	refresh,
	target,
}: {
	class?: string;
	refresh?: string;
	target?: string;
}) => (
	<Button
		type="button"
		class={layout}
		busyLabel="Linking…"
		data-link-bank
		data-link-bank-refresh={refresh}
		data-link-bank-target={target}
	>
		Link a bank
	</Button>
);

/** Where Plaid Link's errors go: under every button that opens it, Accounts' pair included. */
export const LinkBankError = () => <div data-link-bank-error class="mt-3" />;

export const LinkBank = ({
	class: layout,
	refresh,
	target,
}: {
	class?: string;
	refresh?: string;
	target?: string;
}) => (
	<>
		<LinkBankButton class={layout} refresh={refresh} target={target} />
		<LinkBankError />
	</>
);

/** Plaid Link's scripts, on every page that can show Link a bank (the disconnect page swaps Accounts in). */
export const plaidScripts = (on: boolean) => ({
	scripts: on
		? ["https://cdn.plaid.com/link/v2/stable/link-initialize.js"]
		: [],
	modules: on ? ["/js/plaid-link.js"] : [],
});

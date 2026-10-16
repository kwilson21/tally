import { Button } from "./button";

/**
 * Link a bank and its alert region: the one button that opens Plaid Link (public/js/plaid-link.js), and the region its
 * errors go to. Accounts' pair lives inside #accounts-summary, so a refresh redraws it in place. `refresh` and `target`
 * say what Plaid Link's success redraws, the page's URL and the element it swaps in (Accounts uses its defaults; Home
 * redraws its own #page, decision 114).
 */
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
		<div data-link-bank-error class="mt-3" />
	</>
);

/** Plaid Link's scripts, on every page that can show Link a bank (the disconnect page swaps Accounts in). */
export const plaidScripts = (on: boolean) => ({
	scripts: on
		? ["https://cdn.plaid.com/link/v2/stable/link-initialize.js"]
		: [],
	modules: on ? ["/js/plaid-link.js"] : [],
});

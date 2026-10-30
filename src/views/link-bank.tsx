import { Button } from "./button";

/**
 * Link a bank and its alert region: the one button that opens Plaid Link (public/js/plaid-link.js), and the region its
 * errors go to. Accounts' pair lives inside #accounts-summary, so a refresh redraws it in place. `refresh` and `target`
 * say what Plaid Link's success redraws, the page's URL and the element it swaps in (Accounts uses its defaults; Home
 * redraws its own #page, decision 114).
 */
/**
 * The Link a bank button: it opens Plaid Link (public/js/plaid-link.js). `label` and `kind` say what the button reads and how it
 * looks (setup's welcome says "Link your bank"; its reading screen's foot says "Link another bank", secondary).
 */
export const LinkBankButton = ({
	class: layout,
	refresh,
	target,
	label = "Link a bank",
	kind = "primary",
}: {
	class?: string;
	refresh?: string;
	target?: string;
	label?: string;
	kind?: "primary" | "secondary";
}) => (
	<Button
		type="button"
		kind={kind}
		class={layout}
		busyLabel="Linking…"
		data-link-bank
		data-link-bank-refresh={refresh}
		data-link-bank-target={target}
	>
		{label}
	</Button>
);

/** Where Plaid Link's errors go: under every button that opens it, Accounts' pair included. */
export const LinkBankError = () => <div data-link-bank-error class="mt-3" />;

export const LinkBank = ({
	class: layout,
	refresh,
	target,
	label,
	kind,
}: {
	class?: string;
	refresh?: string;
	target?: string;
	label?: string;
	kind?: "primary" | "secondary";
}) => (
	<>
		<LinkBankButton
			class={layout}
			refresh={refresh}
			target={target}
			label={label}
			kind={kind}
		/>
		<LinkBankError />
	</>
);

/** The local handler runs where Plaid actions can appear; it loads Plaid's required CDN SDK only after a Link or repair click. */
export const plaidScripts = (on: boolean) => ({
	// The local handler loads Plaid's required CDN SDK only after Link or repair is requested.
	scripts: [],
	modules: on ? ["/js/plaid-link.js"] : [],
});

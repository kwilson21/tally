import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";

/** True for the design system catalog's pages (decision 42). */
const inCatalog = (path: string) =>
	path === "/design-system" || path.startsWith("/design-system/");

// Plaid Link is the one third-party script, and its hosts are allowed only on Accounts
// and its sub-pages (the disconnect page swaps Accounts in, Link a bank included).
const onAccounts = (path: string) =>
	path === "/accounts" || path.startsWith("/accounts/");

export const security = secureHeaders({
	xFrameOptions: "DENY",
	contentSecurityPolicy: {
		defaultSrc: ["'self'"],
		scriptSrc: [
			(c) =>
				onAccounts(c.req.path) ? "'self' https://cdn.plaid.com" : "'self'",
		],
		styleSrc: ["'self'"],
		fontSrc: ["'self'"],
		imgSrc: ["'self'", "data:"],
		connectSrc: [
			(c) =>
				onAccounts(c.req.path)
					? "'self' https://production.plaid.com"
					: "'self'",
		],
		frameSrc: [
			(c) =>
				onAccounts(c.req.path) ? "'self' https://cdn.plaid.com" : "'self'",
		],
		objectSrc: ["'none'"],
		frameAncestors: ["'none'"],
		baseUri: ["'self'"],
		// No form on a catalog page can submit, even without JavaScript (DESIGN.md "Catalog").
		formAction: [(c) => (inCatalog(c.req.path) ? "'none'" : "'self'")],
	},
});

// Form posts must come from this site: the browser's Sec-Fetch-Site or Origin header has to say so (spec §10).
export const sameOrigin = csrf();

import type { Context } from "hono";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { isValidKey } from "./plaid/token-crypto";

/** True for the design system catalog's pages (decision 42). */
const inCatalog = (path: string) =>
	path === "/design-system" || path.startsWith("/design-system/");

const onAccounts = (path: string) =>
	path === "/accounts" || path.startsWith("/accounts/");

// Plaid's SDK is injected after a Link/repair click. Its CSP hosts are allowed only on configured, non-demo pages
// that expose those actions (including pages that can swap Accounts back in).
export const loadsPlaid = (c: Context) => {
	const enabled =
		c.env.DEMO !== "true" &&
		Boolean(c.env.PLAID_CLIENT_ID && c.env.PLAID_SECRET) &&
		isValidKey(c.env.TOKEN_ENCRYPTION_KEY);
	return enabled && (onAccounts(c.req.path) || c.req.path === "/setup");
};

export const security = secureHeaders({
	xFrameOptions: "DENY",
	// Feedback records the page it came from; the Referer never leaves Tally.
	referrerPolicy: "same-origin",
	contentSecurityPolicy: {
		defaultSrc: ["'self'"],
		scriptSrc: [
			(c) =>
				loadsPlaid(c)
					? "'self' https://cdn.plaid.com/link/v2/stable/link-initialize.js"
					: "'self'",
		],
		// Plaid Link styles its full-screen overlay inline; without this it renders in the page flow.
		styleSrc: [(c) => (loadsPlaid(c) ? "'self' 'unsafe-inline'" : "'self'")],
		fontSrc: ["'self'"],
		imgSrc: ["'self'", "data:"],
		connectSrc: [
			(c) => (loadsPlaid(c) ? "'self' https://production.plaid.com" : "'self'"),
		],
		frameSrc: [
			(c) => (loadsPlaid(c) ? "'self' https://cdn.plaid.com" : "'self'"),
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

import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";

/** True for the design system catalog's pages (decision 42). */
const inCatalog = (path: string) =>
	path === "/design-system" || path.startsWith("/design-system/");

// Everything is served from our own origin; Plaid's CDN is added on the Accounts page in Phase 2.
export const security = secureHeaders({
	xFrameOptions: "DENY",
	contentSecurityPolicy: {
		defaultSrc: ["'self'"],
		scriptSrc: ["'self'"],
		styleSrc: ["'self'"],
		fontSrc: ["'self'"],
		imgSrc: ["'self'", "data:"],
		connectSrc: ["'self'"],
		objectSrc: ["'none'"],
		frameAncestors: ["'none'"],
		baseUri: ["'self'"],
		// No form on a catalog page can submit, even without JavaScript (DESIGN.md "Catalog").
		formAction: [(c) => (inCatalog(c.req.path) ? "'none'" : "'self'")],
	},
});

// Form posts must come from this site: the browser's Sec-Fetch-Site or Origin header has to say so (spec §10).
export const sameOrigin = csrf();

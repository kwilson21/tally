import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";

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
		formAction: ["'self'"],
	},
});

// Form posts must come from this site: the browser's Sec-Fetch-Site or Origin header has to say so (spec §10).
export const sameOrigin = csrf();

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

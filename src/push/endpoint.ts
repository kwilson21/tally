// The push services a device's subscription may point at (decision 149). A signed-in person's form post names the endpoint, and
// the minute run sends to whatever is stored until it answers, so only these hosts are stored or sent to. Any other host would
// have the Worker send requests to any https origin. The route and the ready push both use this one check.

/**
 * The push services, one per browser family: fcm.googleapis.com for Chrome, Android and most other Chromium browsers;
 * push.services.mozilla.com for Firefox; push.apple.com for Safari on a Mac and for the iPhone and iPad web apps (Home Screen);
 * notify.windows.com for Edge on Windows.
 */
export const PUSH_SERVICE_HOSTS = [
	"fcm.googleapis.com",
	"push.services.mozilla.com",
	"push.apple.com",
	"notify.windows.com",
] as const;

/**
 * True when the endpoint is an https URL whose host is one of PUSH_SERVICE_HOSTS or a subdomain of one, with no port but the
 * default. The host is compared lower-cased. A URL that doesn't parse is false.
 */
export function isPushServiceEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	// A URL's port is "" for the default port (443 for https), so a port written out as 443 is the default too.
	if (url.protocol !== "https:" || url.port !== "") return false;
	const host = url.hostname.toLowerCase();
	return PUSH_SERVICE_HOSTS.some(
		(service) => host === service || host.endsWith(`.${service}`),
	);
}

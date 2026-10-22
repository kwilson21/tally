// Tally's service worker (decision 148): it shows the first questions' push and opens Tally when it is tapped. It caches nothing
// and has no fetch handler, so Tally stays server-owned. Registering it asks for nothing; the notification's permission is asked
// only in a tap (push.js). A push must always show a notification, or the browser can revoke the permission, so the words below
// are the fallback for a push that can't be read.

// The fallback copies PUSH_PAYLOAD (src/first-tally/ready-push.ts), whose url is QUESTIONS_PATH; test/sw-js.test.ts keeps them equal.
const FALLBACK = {
	title: "Tally",
	body: "Your three questions are ready. About three minutes to finish setting up your budget.",
	url: "/first-page",
};

/** A path on this site, or the fallback path: never another origin (a `//host` path is another site). */
const sitePath = (url) =>
	typeof url === "string" && url.startsWith("/") && !url.startsWith("//")
		? url
		: FALLBACK.url;

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	event.waitUntil(
		(async () => {
			let payload = FALLBACK;
			try {
				const read = event.data?.json();
				if (
					read &&
					typeof read.title === "string" &&
					typeof read.body === "string"
				)
					payload = { title: read.title, body: read.body, url: read.url };
			} catch {
				payload = FALLBACK;
			}
			await self.registration.showNotification(payload.title, {
				body: payload.body,
				data: { url: sitePath(payload.url) },
				icon: "/icons/icon-192.png",
				tag: "tally-ready",
			});
		})().catch(() =>
			// Even a failed read shows the fallback, so a push always leaves a notification.
			self.registration.showNotification(FALLBACK.title, {
				body: FALLBACK.body,
				data: { url: FALLBACK.url },
				icon: "/icons/icon-192.png",
				tag: "tally-ready",
			}),
		),
	);
});

/** Focuses the first Tally window and navigates it; with none, or if it isn't one this worker controls, opens a new one. */
async function openTally(url) {
	const [first] = await self.clients.matchAll({
		type: "window",
		includeUncontrolled: true,
	});
	if (first) {
		try {
			await first.focus();
			await first.navigate(url);
			return;
		} catch {
			// navigate rejects for a window this worker doesn't control: a new window opens below.
		}
	}
	await self.clients.openWindow(url);
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = sitePath(event.notification.data?.url);
	event.waitUntil(openTally(url));
});

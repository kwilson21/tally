import { describe, expect, it } from "vitest";
import { isPushServiceEndpoint } from "../src/push/endpoint";

// The browsers' push services (decision 149). fcm.googleapis.com and its subdomains serve Chrome Stable and most Chromium
// browsers. jmt17.google.com serves Chrome Beta, Dev and Canary, and unbranded Chromium builds (Chromium's
// push_messaging_constants.cc), and only that exact host: no other google.com name and no subdomain of it.

describe("isPushServiceEndpoint: a browser's push service", () => {
	it.each([
		"https://fcm.googleapis.com/fcm/send/abc",
		"https://jmt17.google.com/fcm/send/abc",
		"https://updates.push.services.mozilla.com/wpush/v2/abc",
		"https://web.push.apple.com/QAbc",
		"https://wns2-par02p.notify.windows.com/w/?token=abc",
	])("accepts %s", (endpoint) => {
		expect(isPushServiceEndpoint(endpoint)).toBe(true);
	});

	it("matches the host in any case, and accepts the default port written out", () => {
		expect(
			isPushServiceEndpoint("https://JMT17.Google.COM:443/fcm/send/abc"),
		).toBe(true);
	});

	it.each([
		"https://www.google.com/",
		"https://google.com/x",
		"https://evil.google.com/x",
		"https://x.jmt17.google.com/x",
		"https://jmt17.google.com.evil.example/x",
		"https://jmt17.google.com:8443/x",
		"http://jmt17.google.com/x",
		"not a url",
	])("refuses %s", (endpoint) => {
		expect(isPushServiceEndpoint(endpoint)).toBe(false);
	});
});

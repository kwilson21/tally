// Synthetic fixtures only: route interception prevents all real network access.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const client = await readFile(
	new URL("../public/js/feedback-diagnostics.js", import.meta.url),
	"utf8",
);
const privacy = await readFile(
	new URL("../public/js/feedback-privacy.js", import.meta.url),
	"utf8",
);
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || undefined,
});

try {
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 1280, height: 800 },
	]) {
		const context = await browser.newContext({ viewport });
		const page = await context.newPage();
		const requests = [];
		const pageErrors = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		await page.addInitScript(() => {
			window.__renderCalls = 0;
			window.html2canvas = async () => {
				window.__renderCalls++;
				return { toDataURL: () => "data:image/jpeg;base64,SECRET" };
			};
		});
		await page.route("**/*", async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			requests.push(url.pathname);
			assert.equal(url.origin, "http://fixture.test");
			assert.equal(request.method(), "GET");
			if (url.pathname === "/client.js")
				return route.fulfill({
					contentType: "application/javascript",
					body: client,
				});
			if (url.pathname === "/feedback-privacy.js")
				return route.fulfill({
					contentType: "application/javascript",
					body: privacy,
				});
			const isFeedback = url.pathname === "/feedback";
			const content = isFeedback
				? '<form action="/feedback"><input name="from" value="/accounts"><input name="return_to" value="/accounts?adjust=1"><input type="checkbox" name="include_diagnostics"><input name="client_context" type="hidden"><input name="device_category" type="hidden" value="Mobile browser"></form>'
				: '<main><p>FAKE Merchant SECRET 123456789 $987.65 note</p></main><a href="/feedback?from=/accounts&return_to=/accounts?adjust=1">Feedback</a>';
			return route.fulfill({
				contentType: "text/html",
				headers: {
					"Content-Security-Policy":
						"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:",
				},
				body: `<!doctype html><html><body>${content}<script type="module" src="/client.js" data-screenshot-preview="true"></script></body></html>`,
			});
		});
		await page.goto("http://fixture.test/accounts");
		await page.evaluate(() => {
			window.dispatchEvent(
				new ErrorEvent("error", { error: new TypeError("Synthetic canary") }),
			);
		});
		const canary = await page.evaluate(() =>
			JSON.parse(sessionStorage.getItem("tally-last-client-error") ?? "null"),
		);
		assert.deepEqual(canary, { name: "TypeError" });
		await page.getByRole("link", { name: "Feedback" }).click();
		await page.waitForURL(/\/feedback\?/);
		await page.locator('[name="include_diagnostics"]').check();
		const diagnostics = await page.evaluate(() => {
			const form = document.querySelector('form[action="/feedback"]');
			form.dispatchEvent(new Event("submit"));
			return JSON.parse(form.querySelector('[name="client_context"]').value);
		});
		assert.equal(diagnostics.errorName, "TypeError");
		assert.equal(diagnostics.deviceCategory, "Mobile browser");
		assert.equal(diagnostics.route, "/accounts");
		assert.equal(await page.locator("fieldset").count(), 0);
		assert.equal(await page.evaluate(() => window.__renderCalls), 0);
		assert.equal(
			await page.evaluate(() =>
				sessionStorage.getItem("tally-feedback-layout-preview"),
			),
			null,
		);
		assert.ok(!requests.some((path) => path.includes("html2canvas")));
		assert.ok(!requests.some((path) => path.includes("screenshot")));
		assert.deepEqual(pageErrors, []);
		await context.close();
		console.log(
			`PASS capture remains disabled at ${viewport.width}x${viewport.height}`,
		);
	}
} finally {
	await browser.close();
}

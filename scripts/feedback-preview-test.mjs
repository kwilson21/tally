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
			return route.fulfill({
				contentType: "text/html",
				headers: {
					"Content-Security-Policy":
						"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:",
				},
				body: `<!doctype html><html><body><main><p>FAKE Merchant SECRET 123456789 $987.65 note</p></main><a href="/feedback?from=/source&return_to=/source?adjust=1">Feedback</a><script src="/client.js" data-screenshot-preview="true" defer></script></body></html>`,
			});
		});
		await page.goto("http://fixture.test/source");
		await page.getByRole("link", { name: "Feedback" }).click();
		await page.waitForURL(/\/feedback\?/);
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
		await context.close();
		console.log(
			`PASS capture remains disabled at ${viewport.width}x${viewport.height}`,
		);
	}
} finally {
	await browser.close();
}

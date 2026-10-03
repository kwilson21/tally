// Synthetic fixtures only: route interception prevents all real network access.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const client = await readFile(
	new URL("../public/js/feedback-diagnostics.js", import.meta.url),
	"utf8",
);
const vendor = await readFile(
	new URL(
		"../node_modules/html2canvas/dist/html2canvas.min.js",
		import.meta.url,
	),
	"utf8",
);
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || undefined,
});
let passed = 0;
async function fixture({
	enabled = true,
	mode = "real",
	viewport = { width: 390, height: 844 },
} = {}) {
	const context = await browser.newContext({ viewport });
	const page = await context.newPage();
	const requests = [];
	const alerts = [];
	let confirms = 0;
	page.on("dialog", async (dialog) => {
		if (dialog.type() === "confirm") confirms++;
		else alerts.push(dialog.message());
		await dialog.accept();
	});
	await page.route("**/*", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		requests.push({ url: request.url(), method: request.method() });
		assert.equal(url.origin, "http://fixture.test");
		assert.equal(request.method(), "GET");
		if (url.pathname === "/client.js")
			return route.fulfill({
				contentType: "application/javascript",
				body: client,
			});
		if (url.pathname === "/vendor/html2canvas.min.js")
			return route.fulfill({
				contentType: "application/javascript",
				body: vendor,
			});
		const feedback = url.pathname === "/feedback";
		const body = feedback
			? '<form action="/feedback"><input name="from" value="/source"><textarea name="message">Synthetic</textarea></form>'
			: '<main><p>FAKE Merchant SECRET 123456789 $987.65 note</p><input value="FAKE SECRET typed"><img alt="SECRET image"><svg><text>SECRET chart</text></svg><div id="modal">SECRET modal</div></main><a href="/feedback?from=/source">Feedback</a>';
		return route.fulfill({
			contentType: "text/html",
			headers: {
				"Content-Security-Policy":
					"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'",
			},
			body: `<!doctype html><html><body>${body}<script src="/client.js" ${enabled ? 'data-screenshot-preview="true"' : ""} defer></script></body></html>`,
		});
	});
	await page.addInitScript(
		({ mode }) => {
			window.__renderCalls = 0;
			window.__rendered = "";
			if (mode !== "real")
				window.html2canvas = async (element) => {
					window.__renderCalls++;
					window.__rendered = element.outerHTML;
					if (mode === "throw") throw new Error("SECRET failure");
					if (mode === "delay")
						await new Promise((resolve) => setTimeout(resolve, 250));
					if (mode === "hang") await new Promise(() => {});
					return {
						toDataURL: () =>
							mode === "size"
								? "x".repeat(680001)
								: "data:image/jpeg;base64,AA==",
					};
				};
		},
		{ mode },
	);
	await page.goto("http://fixture.test/source");
	await page.evaluate(() => {
		document.querySelector("main").style.height = "1600px";
		const modal = document.querySelector("#modal");
		modal.style.cssText =
			"position:fixed;top:30px;left:10px;width:200px;height:100px";
		document.querySelector("a").style.cssText =
			"position:fixed;bottom:20px;left:20px";
	});
	return {
		page,
		context,
		requests,
		alerts,
		get confirms() {
			return confirms;
		},
	};
}
async function test(name, callback) {
	await callback();
	passed++;
	console.log(`PASS ${name}`);
}
try {
	for (const viewport of [
		{ width: 390, height: 844 },
		{ width: 1280, height: 800 },
	])
		await test(`real renderer: masking, viewport, scrolled source/modal, preview/remove/retake ${viewport.width}`, async () => {
			const f = await fixture({ viewport });
			await f.page.evaluate(() => scrollTo(0, 300));
			await f.page.addScriptTag({ url: "/vendor/html2canvas.min.js" });
			await f.page.evaluate(() => {
				const actual = window.html2canvas;
				window.html2canvas = async (el, options) => {
					window.__rendered = el.outerHTML;
					window.__options = options;
					const canvas = await actual(el, options);
					window.__dimensions = [canvas.width, canvas.height];
					return canvas;
				};
			});
			// Save renderer evidence before navigation destroys its document.
			await f.page.exposeFunction("record", (data) => {
				f.evidence = data;
			});
			await f.page.evaluate(() => {
				const actual = window.html2canvas;
				window.html2canvas = async (el, opts) => {
					const result = await actual(el, opts);
					await window.record({
						html: el.outerHTML,
						dimensions: [result.width, result.height],
						options: opts,
					});
					return result;
				};
			});
			await f.page.getByRole("link", { name: "Feedback", exact: true }).click();
			await f.page.waitForURL(/\/feedback\?/);
			await f.page
				.getByAltText("Layout with all content replaced by neutral rectangles")
				.waitFor();
			assert.ok(
				!/SECRET|Merchant|123456789|987\.65|<input|<img|<svg/.test(
					f.evidence.html,
				),
			);
			assert.deepEqual(f.evidence.dimensions, [
				viewport.width,
				viewport.height,
			]);
			assert.ok(f.evidence.html.includes("top: 30px"));
			assert.equal(
				await f.page.locator('input[name*="screenshot"]').count(),
				0,
			);
			assert.equal(
				await f.page.evaluate(() =>
					sessionStorage.getItem("tally-feedback-layout-preview"),
				),
				null,
			);
			await f.page
				.getByRole("link", { name: "Retake from original page" })
				.click();
			await f.page.waitForURL("**/source");
			await f.page.getByRole("link", { name: "Feedback", exact: true }).click();
			await f.page.waitForURL(/\/feedback\?/);
			await f.page.getByRole("button", { name: "Remove preview" }).click();
			assert.equal(await f.page.locator("fieldset").count(), 0);
			await f.context.close();
		});
	await test("disabled: no capture, vendor load or upload", async () => {
		const f = await fixture({ enabled: false });
		await f.page.getByRole("link", { name: "Feedback", exact: true }).click();
		await f.page.waitForURL(/\/feedback\?/);
		assert.equal(f.confirms, 0);
		assert.ok(!f.requests.some((r) => r.url.includes("vendor")));
		assert.equal(await f.page.locator("fieldset").count(), 0);
		await f.context.close();
	});
	for (const mode of ["throw", "size", "hang"])
		await test(`failure handling and cleanup: ${mode}`, async () => {
			const f = await fixture({ mode });
			await f.page.getByRole("link", { name: "Feedback", exact: true }).click();
			await f.page.waitForURL(/\/feedback\?/, { timeout: 15000 });
			assert.equal(f.alerts.length, 1);
			assert.ok(!f.alerts[0].includes("SECRET"));
			assert.equal(await f.page.locator("fieldset").count(), 0);
			await f.context.close();
		});
	await test("repeated clicks capture once", async () => {
		const f = await fixture({ mode: "delay" });
		await f.page.evaluate(() => {
			const link = document.querySelector("a");
			link.click();
			link.click();
		});
		await f.page.waitForURL(/\/feedback\?/);
		assert.equal(f.confirms, 1);
		await f.context.close();
	});
	await test("interrupted capture does not persist or navigate; iframe removed", async () => {
		const f = await fixture({ mode: "delay" });
		await f.page.evaluate(() => {
			document.querySelector("a").click();
			window.dispatchEvent(new Event("pagehide"));
		});
		await f.page.waitForTimeout(500);
		assert.ok(f.page.url().endsWith("/source"));
		assert.equal(
			await f.page.evaluate(() =>
				sessionStorage.getItem("tally-feedback-layout-preview"),
			),
			null,
		);
		assert.equal(await f.page.locator("iframe").count(), 0);
		await f.context.close();
	});
	console.log(`${passed} synthetic browser checks passed`);
} finally {
	await browser.close();
}

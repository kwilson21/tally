// Recategorize, exclude, and change a budget amount end to end (spec §11): Home's band → the Needs category list → the edit sheet → save → Home updates.
// Resets the demo data first, and fails on any console error.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";

const reset = await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
assert.equal(reset.status, 200, "resetting the demo data failed");

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(e.message));

const step = (text) => console.log(`✓ ${text}`);
const rows = () => page.locator("#results li[data-transaction]").count();

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page
	.getByRole("link", { name: /12 transactions need a category/ })
	.click();
await page.waitForURL(/\/transactions\?uncategorized=1$/);
assert.equal(await rows(), 12);
step("Home's band opens the 12 transactions that need a category");

await page.getByRole("link", { name: /Local Bakery/ }).click();
await page.locator('[role="dialog"]').waitFor();
assert.equal(
	await page.evaluate(() => document.activeElement?.id),
	"edit-title",
);
step("tapping a row opens the edit sheet with focus on its heading");

await page.locator("#sheet").getByText("Eating Out", { exact: true }).click();
await page.getByRole("button", { name: "Save" }).click();
await page.locator("#toasts").getByText("Saved Local Bakery").waitFor();
await page.locator('[role="dialog"]').waitFor({ state: "detached" });
assert.equal(await rows(), 11);
assert.match(page.url(), /\/transactions\?uncategorized=1$/);
step("saving shows a toast, closes the sheet, and leaves 11 to categorize");

await page.locator("#results li[data-transaction] a").first().click();
await page.locator('[role="dialog"]').waitFor();
await page.getByText("Exclude from budget", { exact: true }).click();
await page.getByRole("button", { name: "Save" }).click();
await page.locator('[role="dialog"]').waitFor({ state: "detached" });
assert.equal(await rows(), 10);
step("excluding a transaction takes it out of the list, leaving 10");

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page
	.getByRole("link", { name: /10 transactions need a category/ })
	.waitFor();
step("Home now says 10 transactions need a category");

// Change a budget amount (spec §11): Home → Groceries → 650, nudged up $1 and 1¢ → Home shows it.
await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.locator('a[href="/budget/1"]').first().click();
const budget = page.getByLabel(/^Budget from /);
await budget.waitFor();
await budget.fill("650");
await page.getByRole("button", { name: "Increase by $1" }).click();
await page.getByRole("button", { name: "Increase by 1 cent" }).click();
assert.equal(await budget.inputValue(), "651.01");
// The round-up chip appears once there are cents.
await page.getByRole("button", { name: "Round to $652" }).click();
assert.equal(await budget.inputValue(), "652.00");
await page.getByRole("button", { name: "Save" }).click();
await page.locator("#toasts").getByText("Saved the Groceries budget").waitFor();
await page.getByText(/of \$652/).waitFor();
assert.equal(new URL(page.url()).pathname, "/");
step(
	"changing Groceries' budget on Home, with nudges and round-up, shows on Home",
);

// Reorder through htmx: the button inside the edit form must send its own direction.
await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
await page.locator('summary[data-category="3"]').click();
await page
	.locator('details[data-row="3"]')
	.getByRole("button", { name: "Move up" })
	.click();
await page.locator("#toasts").getByText("Moved Gas").waitFor();
assert.deepEqual(
	(
		await page
			.locator("summary[data-category] span.font-medium")
			.allTextContents()
	).slice(0, 3),
	["Groceries", "Gas", "Eating Out"],
);
step("Move up in Settings moves Gas up one place");

await browser.close();
assert.deepEqual(errors, [], `console errors:\n${errors.join("\n")}`);
step("no console errors");

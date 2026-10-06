// Recategorize, exclude, and change a budget amount (the sheet and Adjust mode) end to end (spec §11): Home's band → the Needs category list → the edit sheet → save → Home updates.
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

// Inject simulated insets into the app's same-origin stylesheet to respect its CSP.
await page.route("**/assets/app.css", async (route) => {
	const response = await route.fetch();
	const css = await response.text();
	await route.fulfill({
		response,
		body: `${css}\n:root { --safe-area-top: 59px; --safe-area-right: 44px; --safe-area-bottom: 34px; --safe-area-left: 44px; }`,
	});
});

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.keyboard.press("Tab");
const skipLink = await page.locator('a[href="#main"]').boundingBox();
assert(skipLink);
assert(skipLink.x >= 44);
assert(skipLink.y >= 59);
const shellInsets = await page.evaluate(() => {
	const style = (selector) =>
		getComputedStyle(document.querySelector(selector));
	const rect = (selector) =>
		document.querySelector(selector).getBoundingClientRect();
	return {
		bodyTop: style("body").paddingTop,
		page: {
			left: getComputedStyle(document.querySelector("main").parentElement)
				.paddingLeft,
			right: getComputedStyle(document.querySelector("main").parentElement)
				.paddingRight,
		},
		tabs: {
			bottom: style('nav[aria-label="Tabs"]').paddingBottom,
			left: style('nav[aria-label="Tabs"]').paddingLeft,
			right: style('nav[aria-label="Tabs"]').paddingRight,
			rect: rect('nav[aria-label="Tabs"]'),
		},
		feedback: rect('a[href="/feedback"]'),
	};
});
assert.equal(shellInsets.bodyTop, "59px");
assert.equal(shellInsets.page.left, "64px");
assert.equal(shellInsets.page.right, "64px");
assert.equal(shellInsets.tabs.bottom, "34px");
assert.equal(shellInsets.tabs.left, "44px");
assert.equal(shellInsets.tabs.right, "44px");
assert(shellInsets.feedback.bottom <= shellInsets.tabs.rect.top - 16);
assert(shellInsets.feedback.right <= 390 - 44);
step("phone shell controls stay clear of simulated safe areas");

await page
	.getByRole("link", { name: /12 transactions need a category/ })
	.click();
await page.waitForURL(/\/transactions\/organize$/);
await page.getByRole("heading", { name: "Organize", level: 1 }).waitFor();
step("Home's band opens Organize");

await page.goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
assert.equal(await rows(), 12);
step("the Needs category filter lists the 12 transactions");

await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
await page.locator("#month").selectOption("all");
await page.waitForFunction(() =>
	document
		.querySelector("#add-cash")
		?.getAttribute("href")
		?.includes("month%3Dall"),
);
step("changing a filter in place updates Add cash's way back");
await page.goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
await page.getByRole("link", { name: "Add cash" }).click();
await page.getByRole("textbox", { name: "Amount" }).fill("12.00");
await page.getByLabel("Where").fill("Corner stand");
await page.locator("#sheet").getByText("Groceries", { exact: true }).click();
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.locator("#toasts").getByText("Added Corner stand").waitFor();
await page.getByRole("link", { name: /Corner stand/ }).waitFor();
step("adding $12 cash shows its toast and row");
await page.goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});

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
const sheetInsets = await page.locator('[role="dialog"]').evaluate((sheet) => {
	const style = getComputedStyle(sheet);
	const rect = sheet.getBoundingClientRect();
	const buttons = [
		...sheet.querySelectorAll('button[type="submit"], button'),
	].map((button) => button.getBoundingClientRect().bottom);
	return {
		paddingBottom: style.paddingBottom,
		paddingLeft: style.paddingLeft,
		paddingRight: style.paddingRight,
		contentBottom: rect.bottom - Number.parseFloat(style.paddingBottom),
		buttonBottom: Math.max(...buttons),
	};
});
assert.equal(sheetInsets.paddingBottom, "54px");
assert.equal(sheetInsets.paddingLeft, "64px");
assert.equal(sheetInsets.paddingRight, "64px");
assert(sheetInsets.buttonBottom <= sheetInsets.contentBottom);
step("bottom-sheet controls stay clear of simulated safe areas");
const budget = page.getByLabel(/^Budget from /);
await budget.waitFor();
await budget.fill("650");
await page.getByRole("button", { name: /^Increase .+ by \$1$/ }).click();
await page.getByRole("button", { name: /^Increase .+ by 1 cent$/ }).click();
assert.equal(await budget.inputValue(), "651.01");
// The round-up chip appears once there are cents.
await page.getByRole("button", { name: "Round to $652" }).click();
assert.equal(await budget.inputValue(), "652.00");
// The keyboard nudges like the original's number field: ↓ takes a cent, Shift+↑ adds a dollar.
await budget.press("ArrowDown");
await budget.press("Shift+ArrowUp");
assert.equal(await budget.inputValue(), "652.99");
await page.getByRole("button", { name: "Round to $653" }).click();
await page.getByRole("button", { name: "Save" }).click();
await page.locator("#toasts").getByText("Saved the Groceries budget").waitFor();
await page.getByText(/of \$653/).waitFor();
assert.equal(new URL(page.url()).pathname, "/");
step(
	"changing Groceries' budget on Home, with nudges and round-up, shows on Home",
);

// Adjust mode (#94): Adjust → + on Groceries → each tap saves the next round $10, in place.
await page.getByRole("link", { name: "Adjust budgets" }).click();
await page.getByRole("link", { name: "Done adjusting budgets" }).waitFor();
assert.match(page.url(), /\/\?adjust=1$/);
await page.getByRole("button", { name: "Raise Groceries to $660" }).click();
await page.locator("#toasts").getByText("Groceries is $660 a month").waitFor();
await page.getByText(/of \$660/).waitFor();
assert.equal(
	await page.evaluate(() => document.activeElement?.id),
	"nudge-1-up",
);
step("in Adjust mode, + saves Groceries at the next round $10, keeping focus");

// Two quick taps queue rather than race, so both count and the page shows both. A slow network is
// simulated, so the second tap always lands while the first is still saving (the case that used to
// swap the second answer into the page the first one had already replaced).
const slowNudge = async (route) => {
	await new Promise((resolve) => setTimeout(resolve, 400));
	await route.continue();
};
await page.route("**/nudge/**", slowNudge);
const plus = page.locator("#nudge-1-up");
await plus.click();
await plus.click();
await page.getByText(/of \$680/).waitFor({ timeout: 5000 });
step("two quick taps both count ($680)");

// Done right after a tap waits for the tap, then puts the buttons away; the tap's late answer
// can't bring Adjust mode back.
await plus.click();
await page.getByRole("link", { name: "Done adjusting budgets" }).click();
await page.locator("#toasts").getByText("Groceries is $690 a month").waitFor();
await page.getByRole("link", { name: "Adjust budgets" }).waitFor();
await page.waitForLoadState("networkidle");
assert.equal(await page.locator("#nudge-1-up").count(), 0);
assert.equal(new URL(page.url()).search, "");
await page.getByText(/of \$690/).waitFor();
await page.unroute("**/nudge/**", slowNudge);
step("Done right after a tap keeps the tap ($690) and puts the buttons away");

// Split a transaction, see the server-computed confirmation, then restore it. The first answer
// about the line is held back until after the second part is typed, so a late answer about older
// amounts must not be the line's last word.
await page.goto(`${BASE}/transactions?q=Local+Bakery`, {
	waitUntil: "networkidle",
});
await page.getByRole("link", { name: /Local Bakery/ }).click();
await page.getByRole("link", { name: "Split" }).click();
let lineAnswers = 0;
const slowFirstLine = async (route) => {
	if (++lineAnswers === 1)
		await new Promise((resolve) => setTimeout(resolve, 1500));
	await route.continue();
};
await page.route("**/split/line", slowFirstLine);
const amounts = page.getByLabel(/^Part \d amount$/);
await amounts.nth(0).fill("5.00");
// Past the 300ms delay, so part 1's request goes out before part 2 is typed.
await page.waitForTimeout(400);
await page.getByLabel("Part 1 category").selectOption("1");
await amounts.nth(1).fill("7.00");
await page.getByLabel("Part 2 category").selectOption("5");
await page.getByText("Adds up to $12.00").waitFor();
await page.waitForTimeout(1500);
assert.equal(
	(await page.locator("#split-line").textContent())?.trim(),
	"Adds up to $12.00",
);
await page.unroute("**/split/line", slowFirstLine);
await page.getByRole("button", { name: "Save split" }).click();
await page.locator("#toasts").getByText("Split Local Bakery").waitFor();
assert.equal(await rows(), 3);
step("splitting shows both parts and their parent");
await page
	.getByRole("link", { name: /Local Bakery.*Split transaction/ })
	.click();
await page.getByRole("button", { name: "Remove split" }).click();
await page
	.locator("#toasts")
	.getByText("Removed split from Local Bakery")
	.waitFor();
assert.equal(await rows(), 1);
step("removing the split restores the transaction");

// The demo's Target refund is linked to its purchase (P19): its row says so, and its panel shows the link.
await page.goto(`${BASE}/transactions?q=Target&month=all`, {
	waitUntil: "networkidle",
});
const refundRow = page
	.locator("#results li[data-transaction]")
	.filter({ hasText: "Refund for" });
assert.equal(await refundRow.count(), 1);
assert.match(
	await refundRow.innerText(),
	/Kids · Refund for [A-Z][a-z]{2} \d{1,2}/,
);
assert.equal(
	await page
		.locator("#results li[data-transaction]")
		.filter({ hasText: "$24.99 refunded" })
		.count(),
	1,
);
await refundRow.locator("a").click();
await page.locator('[role="dialog"]').waitFor();
await page.locator("#sheet summary", { hasText: "This refunds…" }).click();
const linked = page.locator('input[name="refund_of"]:checked');
assert.equal(await page.locator("#sheet").locator(linked).count(), 1);
assert.notEqual(
	await page.locator("#sheet").locator(linked).getAttribute("value"),
	"",
);
assert.match(
	await page.locator("#sheet label", { has: linked }).innerText(),
	/\$84\.99 · Kids/,
);
await page
	.getByText(/^Counts in Kids with the [A-Z][a-z]{2} \d{1,2} purchase\.$/)
	.waitFor();
step(
	"the demo refund shows its linked purchase, checked, and Refund for on its row",
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

// Select several uncategorized rows, then set their category in one action (P20 A).
assert.equal((await fetch(`${BASE}/cdn-cgi/handler/scheduled`)).status, 200);
await page.goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
await page.getByRole("link", { name: "Select" }).click();
// The checkbox is visually hidden, so tap the row (its label) as a person would.
const selections = page.locator("#selection-form label:has(input[name=ids])");
await selections.nth(0).click();
await selections.nth(1).click();
assert.equal(
	await page.locator("#selection-form input[name=ids]:checked").count(),
	2,
);
await page.getByText("2 selected", { exact: true }).waitFor();
await page.getByRole("button", { name: "Set category" }).click();
await page
	.locator('[role="dialog"]')
	.getByText("Groceries", { exact: true })
	.click();
await page.getByRole("button", { name: "Save", exact: true }).click();
await page
	.locator("#toasts")
	.getByText("Set 2 transactions to Groceries.")
	.waitFor();
await page.getByText("Needs category (10)", { exact: true }).waitFor();
step(
	"selecting two rows sets Groceries and lowers the uncategorized count by two",
);

await browser.close();
assert.deepEqual(errors, [], `console errors:\n${errors.join("\n")}`);
step("no console errors");

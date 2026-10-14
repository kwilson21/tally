// Recategorize, exclude, and change a budget amount (the sheet and Adjust mode) end to end (spec §11): Home's band → the Needs category list → the edit sheet → save → Home updates.
// Resets the demo data first, and fails on any console error.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";

const reset = await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
assert.equal(reset.status, 200, "resetting the demo data failed");

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || undefined,
});
const page = await browser.newPage({
	viewport: { width: 390, height: 844 },
	reducedMotion: "reduce",
});
const consoleErrors = [];
const pageErrors = [];
const expected422 = [];
const expected500 = [];
page.on(
	"console",
	(m) =>
		m.type() === "error" &&
		consoleErrors.push({ text: m.text(), url: m.location().url }),
);
page.on("pageerror", (e) => pageErrors.push(e.message));

const step = (text) => console.log(`✓ ${text}`);
const rows = () => page.locator("#results li[data-transaction]").count();
const assertPhoneFocusClearsFixedControls = async (path) => {
	await goto(`${BASE}${path}`, { waitUntil: "networkidle" });
	await page.evaluate(() => document.activeElement?.blur());
	const maxTabPresses = 200;
	const seen = new Set();
	let focusLeftPage = false;
	for (let i = 0; i < maxTabPresses; i++) {
		await page.keyboard.press("Tab");
		const focused = await page.evaluate(() => {
			const el = document.activeElement;
			if (!el || el === document.body || el === document.documentElement) {
				return { focusLeftPage: true };
			}
			const rect = el?.getBoundingClientRect();
			return {
				focusLeftPage: false,
				key:
					el.getAttribute("aria-label")?.trim() ||
					el.id ||
					el.getAttribute("href") ||
					el.textContent?.trim().slice(0, 40) ||
					`unnamed <${el.tagName.toLowerCase()}>`,
				bottom: rect?.bottom,
				isTab: !!el?.closest('nav[aria-label="Tabs"]'),
				isFeedback: el?.matches('a[href="/feedback"]'),
				tabTop: document
					.querySelector('nav[aria-label="Tabs"]')
					?.getBoundingClientRect().top,
				feedbackTop: document
					.querySelector('a[href="/feedback"]')
					?.getBoundingClientRect().top,
			};
		});
		if (focused.focusLeftPage) {
			focusLeftPage = true;
			break;
		}
		if (focused.key && !focused.isTab && !focused.isFeedback) {
			assert(
				focused.bottom <=
					Math.min(focused.tabTop, focused.feedbackTop ?? Infinity),
				`${path}: focused item ${focused.key} overlaps phone tabs or Feedback`,
			);
			seen.add(focused.key);
		}
	}
	assert(focusLeftPage, `${path}: focus never left the page`);
	assert(seen.size > 0, `${path}: no page controls received focus`);
};
// A link opens its page with a 150 ms cross-fade (decision 76). A page.goto while it runs makes the
// browser cancel it and log an error, so wait for it to end first, as a person would.
const goto = async (url, options) => {
	await page.waitForFunction(
		() => !document.documentElement.matches(":active-view-transition"),
	);
	return page.goto(url, options);
};

// Inject simulated insets into the app's same-origin stylesheet to respect its CSP.
await page.route("**/assets/app.css", async (route) => {
	const response = await route.fetch();
	const css = await response.text();
	await route.fulfill({
		response,
		body: `${css}\n:root { --safe-area-top: 59px; --safe-area-right: 44px; --safe-area-bottom: 34px; --safe-area-left: 44px; }`,
	});
});

await assertPhoneFocusClearsFixedControls("/transactions?uncategorized=1");
step(
	"Tab keeps every focused transaction control above the phone tabs and Feedback",
);
await assertPhoneFocusClearsFixedControls("/settings");
step(
	"Tab keeps every focused Settings control above the phone tabs and Feedback",
);

await goto(`${BASE}/`, { waitUntil: "networkidle" });
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

for (const width of [390, 1280]) {
	await page.setViewportSize({ width, height: 844 });
	await goto(`${BASE}/settings/suggestions`, { waitUntil: "networkidle" });
	await page.evaluate(() => {
		for (const box of document.querySelectorAll('input[name="ticked"]'))
			box.checked = false;
	});
	const failedSave = page.waitForResponse(
		(response) =>
			response.status() === 422 && response.request().method() === "POST",
	);
	await page.getByRole("button", { name: /Yes, create Pet Care/ }).click();
	const response = await failedSave;
	expected422.push({
		status: response.status(),
		method: response.request().method(),
		url: response.url(),
	});
	await page.locator("#suggestions-page [role=alert]").waitFor();
	assert.equal(
		await page.evaluate(() => document.activeElement?.id),
		"suggestion-title",
	);
}
step(
	"a failed suggestion answer explains itself and focuses the question on phone and desktop",
);

// #460: an answer disables every answer button on the screen while it is sent, so a second press (a double
// click, or Enter twice) sends nothing more, and a failed answer gives focus back to the button pressed. Each
// answer is held here until the test releases it, then answered 500 (what an unhandled error sends, which
// Layout keeps out of the page), so nothing is saved and the steps after this still see 10 to categorize.
await page.setViewportSize({ width: 390, height: 844 });
const answers = [];
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const until = async (check, what) => {
	for (let i = 0; i < 200 && !check(); i++)
		await new Promise((resolve) => setTimeout(resolve, 25));
	assert(check(), `timed out waiting for ${what}`);
};
const answerStates = () =>
	page.$$eval("#suggestions-page button[type=submit]", (buttons) =>
		buttons.map((button) => ({
			value: button.value,
			disabled: button.disabled,
		})),
	);
const allAnswersEnabled = () =>
	page.waitForFunction(() =>
		[
			...document.querySelectorAll("#suggestions-page button[type=submit]"),
		].every((button) => !button.disabled),
	);
await page.route("**/settings/suggestions*", async (route) => {
	if (route.request().method() !== "POST") return route.continue();
	const answer = {
		body: route.request().postData(),
		url: route.request().url(),
	};
	answers.push(answer);
	await new Promise((release) => {
		answer.release = release;
	});
	await route.fulfill({ status: 500, body: "" });
	expected500.push({ status: 500, method: "POST", url: answer.url });
});
await goto(`${BASE}/settings/suggestions`, { waitUntil: "networkidle" });
const somethingElse = page.locator("summary", { hasText: "Something else" });
for (let skips = 0; !(await somethingElse.isVisible()); skips++) {
	assert(skips < 10, "no suggestion offered Something else within 10 skips");
	const before = page.url();
	await page.getByRole("link", { name: "Skip", exact: true }).click();
	await page.waitForURL((url) => url.href !== before);
	await page.waitForLoadState("networkidle");
}
await somethingElse.click();
const yes = page.locator(
	'#suggestions-page button[name="answer"][value="yes"]',
);
const save = page.locator(
	'#suggestions-page button[name="answer"][value="else"]',
);
await save.waitFor();
await yes.focus();
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await until(() => answers.length >= 1, "the answer to reach the server");
await settle();
assert.equal(answers.length, 1, "a second press sends no second answer");
const held = await answerStates();
assert(
	held.length > 1 && held.every((button) => button.disabled),
	`every answer button is disabled while an answer is sent: ${JSON.stringify(held)}`,
);
await save.click({ force: true });
await settle();
assert.equal(answers.length, 1, "a disabled Save and next sends no answer");
answers[0].release();
await page.locator("#toasts").getByText("Couldn't save.").waitFor();
await allAnswersEnabled();
assert.equal(
	await page.evaluate(
		() =>
			document.activeElement?.matches(
				'#suggestions-page button[name="answer"][value="yes"]',
			) === true,
	),
	true,
	"a failed answer gives focus back to the Yes button that was pressed",
);
assert.deepEqual(new URLSearchParams(answers[0].body).getAll("answer"), [
	"yes",
]);
await yes.dblclick();
await until(
	() => answers.length >= 2,
	"the double click's answer to reach the server",
);
await settle();
assert.equal(answers.length, 2, "a double click sends one answer");
assert.deepEqual(new URLSearchParams(answers[1].body).getAll("answer"), [
	"yes",
]);
answers[1].release();
await allAnswersEnabled();
await page.unroute("**/settings/suggestions*");
step(
	"an answer disables every answer button while it is sent, a double click sends one answer, and a failed answer gives focus back",
);

await page.setViewportSize({ width: 390, height: 844 });
await goto(`${BASE}/`, { waitUntil: "networkidle" });

await page
	.getByRole("link", { name: /10 transactions need a category/ })
	.click();
await page.waitForURL(/\/transactions\/organize$/);
await page.getByRole("heading", { name: "Organize", level: 1 }).waitFor();
step("Home's band opens Organize");

await goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
assert.equal(await rows(), 10);
step("the Needs category filter lists the 10 transactions");

await goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
await page.locator("#month").selectOption("all");
await page.waitForFunction(() =>
	document
		.querySelector("#add-cash")
		?.getAttribute("href")
		?.includes("month%3Dall"),
);
step("changing a filter in place updates Add cash's way back");
await goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
await page.getByRole("link", { name: "Add cash" }).click();
await page.getByRole("textbox", { name: "Amount" }).fill("12.00");
await page.getByLabel("Where").fill("Corner stand");
await page.locator("#sheet").getByText("Groceries", { exact: true }).click();
await page.getByRole("button", { name: "Add", exact: true }).click();
await page.locator("#toasts").getByText("Added Corner stand").waitFor();
await page.getByRole("link", { name: /Corner stand/ }).waitFor();
step("adding $12 cash shows its toast and row");

const longCash = "x".repeat(48);
await page.getByRole("link", { name: "Add cash" }).click();
await page.getByRole("textbox", { name: "Amount" }).fill("1.00");
await page.getByLabel("Where").fill(longCash);
await page.locator("#sheet").getByText("Groceries", { exact: true }).click();
await page.getByRole("button", { name: "Add", exact: true }).click();
const toast = page.locator('#toasts [role="status"]', {
	hasText: `Added ${longCash}`,
});
await toast.waitFor({ state: "visible" });
const longToastWidths = await toast.evaluate((toast) => {
	// Read both widths while the short-lived confirmation toast is still in the page.
	return {
		page: toast.ownerDocument.documentElement.scrollWidth,
		viewport: toast.ownerDocument.documentElement.clientWidth,
		toast: toast.scrollWidth,
		toastWidth: toast.clientWidth,
	};
});
assert(
	longToastWidths,
	"long-name confirmation toast was not visible for width check",
);
assert(
	longToastWidths.page <= longToastWidths.viewport,
	"long-name confirmation toast made the phone page wider than the viewport",
);
assert(
	longToastWidths.toast <= longToastWidths.toastWidth,
	"long-name confirmation toast content exceeds the toast width",
);
await page.locator("#results").getByText(longCash).waitFor();
await page.locator("#results").getByText(longCash).click();
await page.locator('[role="dialog"]').waitFor();
const longNameWidths = await page.evaluate(() => {
	const dialog = document.querySelector('[role="dialog"]');
	return {
		page: document.documentElement.scrollWidth,
		viewport: document.documentElement.clientWidth,
		sheet: dialog.scrollWidth,
		sheetWidth: dialog.clientWidth,
	};
});
assert(longNameWidths.page <= longNameWidths.viewport);
assert(longNameWidths.sheet <= longNameWidths.sheetWidth);
step("an unbroken merchant name stays inside the phone edit sheet");

await goto(`${BASE}/transactions?uncategorized=1`, {
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
assert.equal(await rows(), 9);
assert.match(page.url(), /\/transactions\?uncategorized=1$/);
step("saving shows a toast, closes the sheet, and leaves 9 to categorize");

await page.locator("#results li[data-transaction] a").first().click();
await page.locator('[role="dialog"]').waitFor();
await page.getByText("Exclude from budget", { exact: true }).click();
await page.getByRole("button", { name: "Save" }).click();
await page.locator('[role="dialog"]').waitFor({ state: "detached" });
assert.equal(await rows(), 8);
step("excluding a transaction takes it out of the list, leaving 8");

await goto(`${BASE}/`, { waitUntil: "networkidle" });
await page
	.getByRole("link", { name: /8 transactions need a category/ })
	.waitFor();
const visibleBand = await page
	.getByRole("link", { name: /8 transactions need a category/ })
	.evaluate((link) => {
		const visible = link.cloneNode(true);
		visible.querySelectorAll(".sr-only").forEach((element) => {
			element.remove();
		});
		return visible.textContent?.replace(/\s+/g, " ").trim();
	});
assert.match(visibleBand, /8 need a category/);
step(
	"Home now says 8 need a category, with transactions announced to screen readers",
);

// Change a budget amount (spec §11): Home → Groceries → 650, nudged up $1 and 1¢ → Home shows it.
await goto(`${BASE}/`, { waitUntil: "networkidle" });
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
await goto(`${BASE}/transactions?q=Local+Bakery`, {
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
await goto(`${BASE}/transactions?q=Target&month=all`, {
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

// A search runs in every month; "Only October" narrows it and moves focus to the count; one more letter keeps
// that month in the Month choice and the count (#211, decision 101).
await goto(`${BASE}/transactions`, { waitUntil: "networkidle" });
const thisMonth = await page.locator("#month").inputValue();
await page.locator("#q").fill("costco");
await page
	.locator("#result-count")
	.getByText(/ in all months$/)
	.waitFor();
const only = page.getByRole("link", { name: /^Only / });
const onlyMonth = (await only.innerText()).replace(/^Only /, "");
await only.click();
await page
	.locator("#result-count")
	.getByText(new RegExp(`in ${onlyMonth}$`))
	.waitFor();
await page.waitForFunction(() => document.activeElement?.id === "result-count");
assert.equal(await page.locator("#month").inputValue(), thisMonth);
await page.locator("#q").click();
await page.keyboard.press("End");
await page.keyboard.type("s");
await page
	.locator("#result-count")
	.getByText(/"costcos" in /)
	.waitFor();
assert.match(
	await page.locator("#result-count").innerText(),
	new RegExp(`in ${onlyMonth}$`),
);
assert.equal(await page.locator("#month").inputValue(), thisMonth);
step(
	"Only October narrows a search to this month, and one more letter keeps it",
);

// Reorder through htmx: the button inside the edit form must send its own direction.
await goto(`${BASE}/settings`, { waitUntil: "networkidle" });
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

// htmx logs a request that a newer one replaces (hx-sync) as an abort. toast.js ignores that, and the steps
// that replace requests on purpose drop only those lines; any other console error still fails.
const dropReplacedRequestLogs = (from) => {
	const logged = consoleErrors.splice(from);
	consoleErrors.push(
		...logged.filter(
			(error) => !/^htmx: htmx:error: .*abort/i.test(error.text),
		),
	);
};
const slowCount = async (route) => {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	await route.continue().catch(() => {}); // the page may already have replaced this request
};

// Select all from the keyboard: its link leaves with the reply, so focus must land on Set category, not the page top (#215).
const keyboardErrors = consoleErrors.length;
await goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
await page.getByRole("link", { name: "Select" }).click();
await page.locator("#selection-form label:has(input[name=ids])").nth(0).click();
const selectAll = page.getByRole("link", { name: /^Select all \d+$/ });
await selectAll.focus();
await page.keyboard.press("Enter");
await selectAll.waitFor({ state: "detached" });
assert.equal(
	await page.evaluate(() => document.activeElement?.id),
	"set-category-selection",
	"Select all must leave focus on Set category",
);
await page.getByText(/^\d+ selected$/).waitFor();
step("Select all from the keyboard keeps focus on Set category");
dropReplacedRequestLogs(keyboardErrors);

// A tick's count reply is held back while focus goes to Select all. The reply swaps the page link for the whole-set
// link: the link keeps its element and its focus, so Enter still selects the whole set (#455).
const linkErrors = consoleErrors.length;
await goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "networkidle",
});
const monthRows = await page
	.locator("#selection-form input[name=ids]")
	.evaluateAll((inputs) => inputs.map((input) => input.value));
await goto(
	`${BASE}/transactions?month=all&select=1&ids=${monthRows.slice(0, -1).join(",")}`,
	{ waitUntil: "networkidle" },
);
await page.route("**/transactions/select/count*", slowCount);
await page.locator("#selection-form input[name=ids]").last().focus();
await page.keyboard.press("Space");
// The list's pager (Older) sits between the last row and the bar, so Tab goes through it to Select all.
await page.keyboard.press("Tab");
await page.keyboard.press("Tab");
assert.equal(
	await page.evaluate(() => document.activeElement?.id),
	"select-all-link",
	"Tab from the last tick must reach Select all, through the pager",
);
await page.waitForTimeout(1600);
await page.waitForLoadState("networkidle");
const wholeLink = page.locator("#select-all-page a");
const wholeLabel = (await wholeLink.textContent())?.trim() ?? "";
assert.match(
	wholeLabel,
	/^Select all \d+ in /,
	"the reply must draw the whole-set link in place of the page link",
);
assert.ok(
	await page.evaluate(() =>
		Boolean(document.activeElement?.closest("#select-all-page")),
	),
	"focus must stay on Select all through the reply",
);
const wholeTotal = Number(wholeLabel.match(/\d+/)?.[0]);
await page.keyboard.press("Enter");
await page.waitForFunction(
	() => document.activeElement?.id === "set-category-selection",
);
assert.match(
	(await page.locator("#selected-count").textContent())?.trim() ?? "",
	new RegExp(`^${wholeTotal} selected`),
	"Enter must select the whole set",
);
await page.unroute("**/transactions/select/count*", slowCount);
dropReplacedRequestLogs(linkErrors);
step(
	"a tick's slow count keeps focus on Select all as it becomes the whole-set link, and Enter selects the whole set",
);

// A tick's count reply draws no link at all, since every matched row is now ticked: the link had focus, so htmx moves
// that focus to the count, the bar's focus stop, and never drops it to the body (#455).
const countErrors = consoleErrors.length;
await goto(`${BASE}/transactions?q=Local+Bakery&select=1`, {
	waitUntil: "networkidle",
});
const bakeryRows = await page
	.locator("#selection-form input[name=ids]")
	.evaluateAll((inputs) => inputs.map((input) => input.value));
await goto(
	`${BASE}/transactions?q=Local+Bakery&select=1&ids=${bakeryRows.slice(0, -1).join(",")}`,
	{ waitUntil: "networkidle" },
);
await page.route("**/transactions/select/count*", slowCount);
await page.locator("#selection-form input[name=ids]").last().focus();
await page.keyboard.press("Space");
await page.keyboard.press("Tab");
assert.equal(
	await page.evaluate(() => document.activeElement?.id),
	"select-all-link",
	"Tab from the last tick must reach Select all",
);
await page.waitForTimeout(1600);
await page.waitForLoadState("networkidle");
assert.equal(
	await page.locator("#select-all-page a").count(),
	0,
	"a reply that ticks every matched row must draw no link",
);
assert.ok(
	await page.evaluate(() =>
		Boolean(document.activeElement?.closest("#selected-count")),
	),
	"focus must move to the bar's count, not the body",
);
assert.equal(
	(await page.locator("#selected-count").textContent())?.trim(),
	`${bakeryRows.length} selected`,
	"the count must say every matched row is ticked",
);
await page.unroute("**/transactions/select/count*", slowCount);
dropReplacedRequestLogs(countErrors);
step(
	"a tick's slow count that draws no link moves focus to the count, not the body",
);

// A count that takes the link away while focus is on it leaves focus on the count. Then a count that draws the link
// again must move focus to the link, not the body (#475). From the keyboard: Space ticks the row (the first count is in
// flight), Tab goes to the link, Shift+Tab back to the row, and Space unticks it (queued behind the first count). Tab
// once more puts focus on the link before the first count lands, so that count takes the link away with focus on it.
const returnErrors = consoleErrors.length;
await goto(`${BASE}/transactions?q=Local+Bakery&select=1`, {
	waitUntil: "networkidle",
});
await page.route("**/transactions/select/count*", slowCount);
await page.locator("#selection-form input[name=ids]").last().focus();
await page.keyboard.press("Space");
await page.keyboard.press("Tab");
await page.keyboard.press("Shift+Tab");
await page.keyboard.press("Space");
await page.keyboard.press("Tab");
await page.waitForFunction(() => {
	const focused = document.activeElement;
	return focused?.id === "select-all-link" && focused.tagName === "SPAN";
});
await page.waitForFunction(
	() => document.querySelector("#select-all-page a") !== null,
);
await page.waitForLoadState("networkidle");
assert.ok(
	await page.evaluate(() =>
		Boolean(document.activeElement?.closest("#select-all-page a")),
	),
	"a count that draws the link again must move focus to the link, not the body",
);
await page.unroute("**/transactions/select/count*", slowCount);
dropReplacedRequestLogs(returnErrors);
step(
	"a count that draws the link again while focus is on the count moves focus to the link",
);

// A press held on Select all across a slow count reply still selects the whole set when it is let go (#473's gap).
const pressErrors = consoleErrors.length;
await goto(
	`${BASE}/transactions?month=all&select=1&ids=${monthRows.slice(0, -1).join(",")}`,
	{ waitUntil: "networkidle" },
);
await page.route("**/transactions/select/count*", slowCount);
await page.locator("#selection-form input[name=ids]").last().focus();
await page.keyboard.press("Space");
const pressLink = page.locator("#select-all-page a");
const pressBox = await pressLink.boundingBox();
await page.mouse.move(
	pressBox.x + pressBox.width / 2,
	pressBox.y + pressBox.height / 2,
);
await page.mouse.down();
await page.waitForTimeout(1600);
await page.waitForLoadState("networkidle");
const pressLabel = (await pressLink.textContent())?.trim() ?? "";
assert.match(
	pressLabel,
	/^Select all \d+ in /,
	"the reply must draw the whole-set link while the press is held",
);
const pressTotal = Number(pressLabel.match(/\d+/)?.[0]);
await page.mouse.up();
await page.waitForFunction(
	() => document.activeElement?.id === "set-category-selection",
);
assert.match(
	(await page.locator("#selected-count").textContent())?.trim() ?? "",
	new RegExp(`^${pressTotal} selected`),
	"letting go after a slow count must select the whole set",
);
await page.unroute("**/transactions/select/count*", slowCount);
dropReplacedRequestLogs(pressErrors);
step(
	"a press held on Select all across a slow count selects the whole set when let go",
);

// A count still loading when Select all lands must not overwrite the bar with its stale count (#215).
let errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
await page.route("**/transactions/select/count*", slowCount);
await page.getByRole("link", { name: "Select" }).click();
await page.locator("#selection-form label:has(input[name=ids])").nth(0).click();
await page.getByRole("link", { name: /^Select all \d+$/ }).click();
await page.waitForTimeout(1600);
await page.waitForLoadState("networkidle");
const selectable = await page
	.locator("#selection-form input[name=ids]")
	.count();
assert.equal(
	await page.locator("#selection-form input[name=ids]:not(:checked)").count(),
	0,
	"Select all must tick every row on the page",
);
assert.equal(
	(await page.locator("#selected-count").textContent())?.trim(),
	`${selectable} selected`,
	"a count that loaded before Select all must not overwrite its count",
);
assert.equal(
	await page.getByRole("link", { name: /^Select all \d+$/ }).count(),
	0,
	"the Select all link must leave with the reply",
);
assert.equal(await page.locator("#toasts [role=alert]").count(), 0);
await page.unroute("**/transactions/select/count*", slowCount);
dropReplacedRequestLogs(errorsBefore);
step("a count still loading when Select all lands can't overwrite the bar");

// Select all, then a filter change before its list comes back: the old list must not return ticked (#215).
const slowSelectAll = async (route) => {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	await route.continue().catch(() => {});
};
errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
await page.getByRole("link", { name: "Select" }).click();
await page.route(
	"**/transactions?*focus=set-category-selection*",
	slowSelectAll,
);
await page.getByRole("link", { name: /^Select all \d+$/ }).click();
await page.getByLabel("Search transactions").fill("Local Bakery");
await page.waitForTimeout(1600);
await page.waitForLoadState("networkidle");
assert.match(
	page.url(),
	/[?&]q=Local/,
	"the search must be the list that stays",
);
assert.equal(
	await page.locator("#selection-form input[name=ids]:checked").count(),
	0,
	"the old list must not come back ticked",
);
await page.unroute(
	"**/transactions?*focus=set-category-selection*",
	slowSelectAll,
);
dropReplacedRequestLogs(errorsBefore);
step("Select all, then a filter change before it returns, keeps the filter");

// Next while a count is still loading: page 2 must get its own ids, not page 1's (#215).
errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?month=all`, { waitUntil: "networkidle" });
await page.route("**/transactions/select/count*", slowCount);
await page.getByRole("link", { name: "Select" }).click();
await page.locator("#selection-form label:has(input[name=ids])").nth(0).click();
await page.locator('a[rel="next"]').click();
await page.waitForTimeout(1600);
await page.waitForLoadState("networkidle");
assert.match(page.url(), /[?&]page=2\b/);
const shownIds = await page
	.locator("#results input[name=ids]")
	.evaluateAll((inputs) => inputs.map((input) => input.value).join(","));
assert.equal(
	await page.locator("#select-all-page input[name=page-ids]").inputValue(),
	shownIds,
	"page 2's Select all must hold page 2's ids",
);
await page.unroute("**/transactions/select/count*", slowCount);
dropReplacedRequestLogs(errorsBefore);
step("Next while a count loads gives page 2 its own ids");

// A tap during a Select-mode list load does nothing: the rows and actions are out of reach, and no count starts from the page that is leaving (#215).
errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?month=all`, { waitUntil: "networkidle" });
await page.getByRole("link", { name: "Select" }).click();
const pausedRows = page.locator("#selection-form label:has(input[name=ids])");
await pausedRows.nth(0).click();
await page.getByText("1 selected", { exact: true }).waitFor();
const countRequests = [];
const recordCount = (request) => {
	if (request.url().includes("/transactions/select/count"))
		countRequests.push(request.url());
};
page.on("request", recordCount);
const slowList = async (route) => {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	await route.continue().catch(() => {}); // the page may already have replaced this request
};
await page.route("**/transactions?*page=2*", slowList);
const countsBeforeLoad = countRequests.length;
await page.locator('a[rel="next"]').click();
await page.waitForTimeout(200);
assert.equal(
	await page.locator("#selection-form.htmx-request").count(),
	1,
	"the list's load must mark the selection form",
);
assert.equal(await page.locator("#set-category-selection").isDisabled(), true);
assert.equal(await page.locator("#exclude-selection").isDisabled(), true);
assert.equal(
	await page
		.locator("#selection-form .selection-mark")
		.first()
		.evaluate((el) => getComputedStyle(el).opacity),
	"0.4",
	"the round marks fade to 40% once the load runs past 150 ms",
);
assert.equal(
	await pausedRows
		.nth(0)
		.locator("span.min-w-0")
		.first()
		.evaluate((el) => getComputedStyle(el).opacity),
	"1",
	"the row's words stay full ink",
);
const tapBox = await pausedRows.nth(1).boundingBox();
await page.mouse.click(
	tapBox.x + tapBox.width / 2,
	tapBox.y + tapBox.height / 2,
);
await page.waitForTimeout(300);
assert.equal(
	await page.locator("#selection-form input[name=ids]").nth(1).isChecked(),
	false,
	"a tap during the load must not tick a row",
);
assert.equal(
	countRequests.length,
	countsBeforeLoad,
	"a tap during the load must not send a count",
);
await page.waitForFunction(
	() => !document.querySelector("#selection-form.htmx-request"),
);
await page.unroute("**/transactions?*page=2*", slowList);
const pageTwoIds = await page
	.locator("#results input[name=ids]")
	.evaluateAll((inputs) => inputs.map((input) => input.value).join(","));
assert.equal(
	await page.locator("#select-all-page input[name=page-ids]").inputValue(),
	pageTwoIds,
	"page 2's Select all must hold page 2's ids",
);
// The tick from page 1 stays ticked and counts, as a tick not on this page (#350).
const ticksOnPageTwo = await page
	.locator("#results input[name=ids]:checked")
	.count();
const ticksNotOnPage = await page
	.locator("#not-on-page input[name=ids]:checked")
	.count();
assert.equal(ticksNotOnPage, 1, "page 1's tick must stay ticked off the page");
assert.equal(
	(await page.locator("#selected-count").textContent())?.trim(),
	`${ticksOnPageTwo + ticksNotOnPage} selected, ${ticksNotOnPage} not on this page`,
	"the count must match every tick, on this page or not",
);
// Focus is on the first row's tick, and the tick is visible: the rows are hidden until a load ends (#456).
const firstTickHasFocus = () =>
	page.evaluate(() => {
		const tick = document.querySelector("#results input[name=ids]");
		return (
			document.activeElement === tick &&
			getComputedStyle(tick).visibility === "visible"
		);
	});
assert.equal(
	await firstTickHasFocus(),
	true,
	"focus must move to the first row's tick once the list lands",
);
assert.equal(
	countRequests.length,
	countsBeforeLoad,
	"no count may start from the page that left",
);
page.off("request", recordCount);
dropReplacedRequestLogs(errorsBefore);
step(
	"a tap during a list load does nothing, and focus lands on the first tick",
);

// Newer's load ends the same way, with focus on the page's first tick, once the rows are shown (#456).
await page.route("**/transactions?*focus=first-tick*", slowList);
await page.locator('a[rel="prev"]').click();
await page.waitForSelector("#selection-form.htmx-request");
await page.waitForFunction(
	() => !document.querySelector("#selection-form.htmx-request"),
);
await page.unroute("**/transactions?*focus=first-tick*", slowList);
assert.equal(
	await firstTickHasFocus(),
	true,
	"Newer must move focus to the first row's tick once its list lands",
);
step("Newer moves focus to the first row's tick once its list lands");

// A second filter change during a list load keeps the ticks: the newest list carries the ticks still checked (#215).
errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "networkidle",
});
const tickable = page.locator("#selection-form label:has(input[name=ids])");
await tickable.nth(0).click();
await tickable.nth(1).click();
await page.getByText("2 selected", { exact: true }).waitFor();
const slowLists = async (route) => {
	await new Promise((resolve) => setTimeout(resolve, 1500));
	await route.continue().catch(() => {}); // the page may already have replaced this request
};
await page.route("**/transactions?*", slowLists);
await page.locator("#show").selectOption("spending");
await page.waitForTimeout(400);
await page.locator("#show").selectOption("all");
await page.waitForFunction(
	() => !document.querySelector("#selection-form.htmx-request"),
);
await page.unroute("**/transactions?*", slowLists);
assert.equal(
	await page.locator("#selection-form input[name=ids]:checked").count(),
	2,
	"both ticks must survive a second filter change during a list load",
);
await page.getByText("2 selected", { exact: true }).waitFor();
dropReplacedRequestLogs(errorsBefore);
step("a second filter change during a list load keeps the ticks");

// A tap puts its tick in the address, so a reload keeps it (#350).
await goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "networkidle",
});
await page.locator("#selection-form label:has(input[name=ids])").nth(0).click();
await page.getByText("1 selected", { exact: true }).waitFor();
await page.waitForURL(/[?&]ids=/);
await page.reload({ waitUntil: "networkidle" });
await page.getByText("1 selected", { exact: true }).waitFor();
assert.equal(
	await page.locator("#selection-form input[name=ids]:checked").count(),
	1,
	"a reload must keep the tick",
);
step("a tick stays ticked across a reload");

// A tick stays when Older takes its page away: the bar still counts it, as a tick not on this page (#350).
await goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "networkidle",
});
await page.locator("#selection-form label:has(input[name=ids])").nth(0).click();
await page.getByText("1 selected", { exact: true }).waitFor();
await page.locator('a[rel="next"]').click();
await page.waitForFunction(
	() =>
		document.querySelector("#selected-count")?.textContent?.trim() ===
		"1 selected, 1 not on this page",
);
assert.equal(
	(await page.locator("#not-on-page summary").textContent())?.trim(),
	"1 not on this page",
	"Older must keep the tick and say it is not on this page",
);
assert.match(
	page.url(),
	/[?&]ids=/,
	"Older's address must carry the tick, so a reload keeps it",
);
step(
	"a tick stays when Older takes its page away, and the bar still counts it",
);
// Unticking the last tick off the page from the keyboard takes its line away with the count, and focus
// moves into the bar (Select all) rather than dropping to the page (#350).
await page.locator("#not-on-page summary").focus();
await page.keyboard.press("Enter");
await page.locator("#not-on-page input[name=ids]").first().focus();
await page.keyboard.press("Space");
await page.waitForFunction(
	() => !document.querySelector("#not-on-page summary"),
);
assert.equal(
	(await page.locator("#selected-count").textContent())?.trim(),
	"0 selected",
	"the count must lose the tick and the line must go with it",
);
await page.waitForFunction(
	() => !!document.activeElement?.closest("#select-all-page"),
);
step(
	"unticking the last tick off the page from the keyboard takes its line away and keeps focus in the bar",
);

// Select several uncategorized rows, then set their category in one action (P20 A).
assert.equal((await fetch(`${BASE}/cdn-cgi/handler/scheduled`)).status, 200);
await goto(`${BASE}/transactions?uncategorized=1`, {
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
await page.getByText("Needs category (8)", { exact: true }).waitFor();
step(
	"selecting two rows sets Groceries and lowers the uncategorized count by two",
);

// Seven-figure amounts on a 320px phone (decision 110). The writes go to the local D1 after everything
// above has run, so no earlier step sees them; the demo reset below puts the seed's numbers back.
const writeLocalD1 = (sql) =>
	execFileSync(
		"npx",
		["wrangler", "d1", "execute", "DB", "--local", "--command", sql],
		{ stdio: "pipe" },
	);
const now = new Date();
const finishedMonth = new Date(
	Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1),
)
	.toISOString()
	.slice(0, 7);
writeLocalD1(
	`INSERT OR REPLACE INTO budget_amounts (category_id, effective_month, amount_cents) SELECT id, '${finishedMonth}', 200000000 FROM categories WHERE name = 'Groceries'; UPDATE accounts SET balance_cents = balance_cents + 100000000 WHERE is_liability = 0`,
);
await page.setViewportSize({ width: 320, height: 844 });
// A headline of 9 or more characters is one size smaller under 640px, 48px here, and nothing scrolls sideways.
const assertHeadlineFitsPhone = async (headline, what) => {
	await headline.waitFor();
	assert(
		(await headline.innerText()).length >= 9,
		`${what} should show a seven-figure amount`,
	);
	const fontSize = await headline.evaluate(
		(el) => getComputedStyle(el).fontSize,
	);
	assert.equal(fontSize, "48px", `${what} is not one size smaller at 320px`);
	const scrollWidth = await page.evaluate(
		() => document.documentElement.scrollWidth,
	);
	assert(
		scrollWidth <= 320,
		`${what} scrolls sideways at 320px: ${scrollWidth}px`,
	);
};
await goto(`${BASE}/?month=${finishedMonth}`, { waitUntil: "networkidle" });
await assertHeadlineFitsPhone(
	page.locator('section[aria-label$=" ended"]').locator("p.whitespace-nowrap"),
	"a finished month's result",
);
step(
	"a finished month's seven-figure result fits a 320px phone one size smaller",
);
await goto(`${BASE}/accounts`, { waitUntil: "networkidle" });
await assertHeadlineFitsPhone(
	page
		.getByText("Net worth", { exact: true })
		.first()
		.locator("xpath=following-sibling::p[1]"),
	"Net worth",
);
step("a seven-figure Net worth fits a 320px phone one size smaller");
const restored = await fetch(`${BASE}/cdn-cgi/handler/scheduled`);
assert.equal(restored.status, 200, "restoring the demo data failed");

await browser.close();
// Tie the two intentional failed saves to their resource URLs; unrelated 422s cannot substitute.
const expected422Errors = consoleErrors.filter((error) =>
	error.text.includes("status of 422"),
);
const expected500Errors = consoleErrors.filter((error) =>
	error.text.includes("status of 500"),
);
const otherErrors = consoleErrors.filter(
	(error) =>
		!error.text.includes("status of 422") &&
		!error.text.includes("status of 500"),
);
const expected422Urls = expected422.map(({ url }) => url).sort();
const logged422Urls = expected422Errors.map(({ url }) => url).sort();
const expected500Urls = expected500.map(({ url }) => url).sort();
const logged500Urls = expected500Errors.map(({ url }) => url).sort();
const diagnostics = `expected 422 responses (method + URL): ${JSON.stringify(expected422)}\n422 console errors (text + URL): ${JSON.stringify(expected422Errors)}\nexpected 500 replies (method + URL): ${JSON.stringify(expected500)}\n500 console errors (text + URL): ${JSON.stringify(expected500Errors)}\nother console errors: ${JSON.stringify(otherErrors)}\npage errors: ${JSON.stringify(pageErrors)}`;
assert.deepEqual(
	logged422Urls,
	expected422Urls,
	`each deliberate 422 response must have exactly one matching console error by URL; missing messages may indicate Chromium folded duplicates\n${diagnostics}`,
);
assert.deepEqual(
	logged500Urls,
	expected500Urls,
	`each deliberate 500 reply must have exactly one matching console error by URL; missing messages may indicate Chromium folded duplicates\n${diagnostics}`,
);
assert.deepEqual(
	{ console: otherErrors, page: pageErrors },
	{ console: [], page: [] },
	`expected 422 responses: ${JSON.stringify(expected422)}\n422 console errors: ${JSON.stringify(expected422Errors)}\nother console errors: ${JSON.stringify(otherErrors)}\npage errors: ${JSON.stringify(pageErrors)}`,
);
step("no console errors");

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
				tabTop: document
					.querySelector('nav[aria-label="Tabs"]')
					?.getBoundingClientRect().top,
			};
		});
		if (focused.focusLeftPage) {
			focusLeftPage = true;
			break;
		}
		if (focused.key && !focused.isTab) {
			assert(
				focused.bottom <= focused.tabTop,
				`${path}: focused item ${focused.key} overlaps the phone tabs`,
			);
			seen.add(focused.key);
		}
	}
	assert(focusLeftPage, `${path}: focus never left the page`);
	assert(seen.size > 0, `${path}: no page controls received focus`);
};
// htmx is a deferred script, so a page reads "interactive" before htmx has run, and a click or fill that lands then
// reaches no htmx listener. A step waits for htmx on each page it opens, before it types or clicks there.
const htmxReady = () => page.waitForFunction(() => Boolean(window.htmx));
// A link opens its page with a 150 ms cross-fade (decision 76). A page.goto while it runs makes the
// browser cancel it and log an error, so wait for it to end first, as a person would.
const goto = async (url, options) => {
	await page.waitForFunction(
		() => !document.documentElement.matches(":active-view-transition"),
	);
	await page.goto(url, options);
	await htmxReady();
};
// click() doesn't wait for the page a plain link opens, so this takes that page's load event first. The listener is
// set before the click, and load fires after htmx has run; then htmx is awaited as goto does.
const followLink = async (link) => {
	await Promise.all([page.waitForEvent("load"), link.click()]);
	await htmxReady();
};
// A slowed reply is let go after its delay, and each release is kept here. settleReplies waits for every kept release, so a
// step waits for the replies it slowed to be answered or dropped, rather than for a guessed time.
const heldReplies = [];
const holdReply = (route, delay) => {
	const released = new Promise((resolve) => setTimeout(resolve, delay)).then(
		() => route.continue().catch(() => {}), // the page may already have replaced this request
	);
	heldReplies.push(released);
	return released;
};
// Waits for every held reply to be let go, then for htmx to have no request in flight: a reply the page replaced is gone,
// and one it kept has been swapped in, so the assertions after this read the page the reply left.
const settleReplies = async () => {
	await Promise.all(heldReplies.splice(0));
	await page.waitForFunction(() => !document.querySelector(".htmx-request"));
};
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
step("Tab keeps every focused transaction control above the phone tabs");
await assertPhoneFocusClearsFixedControls("/settings");
step("Tab keeps every focused Settings control above the phone tabs");

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
		feedback: rect('#top-line a[href="/feedback"]'),
		feedbackPosition: style('#top-line a[href="/feedback"]').position,
	};
});
assert.equal(shellInsets.bodyTop, "59px");
assert.equal(shellInsets.page.left, "64px");
assert.equal(shellInsets.page.right, "64px");
assert.equal(shellInsets.tabs.bottom, "34px");
assert.equal(shellInsets.tabs.left, "44px");
assert.equal(shellInsets.tabs.right, "44px");
// The pill sits in the phone's top line, beside the wordmark, below the notch and never fixed (P123 A).
assert.notEqual(shellInsets.feedbackPosition, "fixed");
assert(shellInsets.feedback.top >= 59);
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
await followLink(page.getByRole("link", { name: "Split" }));
let lineAnswers = 0;
const slowFirstLine = async (route) => {
	if (++lineAnswers === 1) return holdReply(route, 1500);
	await route.continue();
};
await page.route("**/split/line", slowFirstLine);
const amounts = page.getByLabel(/^Part \d amount$/);
// The amount waits out a 300ms debounce, so wait for part 1's request to go before part 2 is typed.
const firstLineSent = page.waitForRequest("**/split/line");
await amounts.nth(0).fill("5.00");
await firstLineSent;
await page.getByLabel("Part 1 category").selectOption("1");
await amounts.nth(1).fill("7.00");
await page.getByLabel("Part 2 category").selectOption("5");
await page.getByText("Adds up to $12.00").waitFor();
// The held first answer lands (or is dropped) before the line is read, so a late answer can't be the line's last word.
await settleReplies();
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

// A split of a purchase with a linked refund asks which part the refund goes with. The part labels redraw out of band as
// the parts change, and a pick made while that redraw is held stays checked and focused. The demo's Target purchase
// ($84.99) has a linked $24.99 refund; the sheet is cancelled, so the demo data stays as it was.
const errorsBeforeChooser = consoleErrors.length;
await goto(`${BASE}/transactions?q=Target&month=all`, {
	waitUntil: "networkidle",
});
await page
	.locator("#results li[data-transaction]")
	.filter({ hasText: "$24.99 refunded" })
	.locator("a")
	.click();
await page.locator('[role="dialog"]').waitFor();
await followLink(page.getByRole("link", { name: "Split" }));
const chooserAmounts = page.getByLabel(/^Part \d amount$/);
await page.getByLabel("Part 1 category").selectOption({ label: "Kids" });
await chooserAmounts.nth(0).fill("60.00");
await page.getByLabel("Part 2 category").selectOption({ label: "Household" });
await chooserAmounts.nth(1).fill("24.99");
// The out-of-band part label lands: the radio is named by its new text, not the "Part 2" it had.
const household = page.getByRole("radio", { name: "Household · $24.99" });
await household.waitFor({ state: "attached" });
await page.waitForFunction(() => !document.querySelector(".htmx-request"));
// Hold the next answer about the chooser, and let every later one through.
let heldLine = null;
let lineHeld;
const lineIsHeld = new Promise((resolve) => (lineHeld = resolve));
const holdNextLine = (route) => {
	if (heldLine) return route.continue();
	heldLine = route;
	lineHeld();
};
await page.route("**/split/line", holdNextLine);
await page.evaluate(() => {
	window.__lineEnded = false;
	document.addEventListener("htmx:finally:request", (event) => {
		if (event.detail.ctx.request.action.includes("/split/line"))
			window.__lineEnded = true;
	});
});
await chooserAmounts.nth(0).fill("50.00");
await lineIsHeld;
await household.focus();
await page.keyboard.press("Space");
assert.equal(await household.isChecked(), true);
await heldLine.continue();
await page.waitForFunction(() => window.__lineEnded);
await page.getByRole("radio", { name: "Kids · $50.00" }).waitFor({
	state: "attached",
});
assert.equal(await household.isChecked(), true);
assert.equal(
	await household.evaluate((el) => document.activeElement === el),
	true,
	"the pick must keep focus through the redraw",
);
await page.getByRole("link", { name: "Cancel" }).click();
await page.locator('[role="dialog"]').waitFor({ state: "hidden" });
await page.unroute("**/split/line", holdNextLine);
dropReplacedRequestLogs(errorsBeforeChooser);
step("a pick made while the chooser's labels redraw stays checked and focused");

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

const slowCount = (route) => holdReply(route, 1500);

// Select all from the keyboard: its link leaves with the reply, so focus must land on Set category, not the page top (#215).
const keyboardErrors = consoleErrors.length;
await goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
await followLink(page.getByRole("link", { name: "Select" }));
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
// The held reply draws the whole-set link in place of the page link (the same element, so focus stays on it).
await page
	.locator("#select-all-page a", { hasText: /^Select all \d+ in / })
	.waitFor();
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
// The held reply takes the link away and htmx moves focus to the count: wait for both before reading them.
await page.locator("#select-all-page a").waitFor({ state: "detached" });
await page.waitForFunction(() =>
	Boolean(document.activeElement?.closest("#selected-count")),
);
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
await page
	.locator("#select-all-page a", { hasText: /^Select all \d+ in / })
	.waitFor();
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
await followLink(page.getByRole("link", { name: "Select" }));
await page.locator("#selection-form label:has(input[name=ids])").nth(0).click();
await page.getByRole("link", { name: /^Select all \d+$/ }).click();
// The Select all list replaces the count still in flight: settle waits for that count to be let go, and for the list to land.
await settleReplies();
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
const slowSelectAll = (route) => holdReply(route, 1500);
errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
await followLink(page.getByRole("link", { name: "Select" }));
await page.route(
	"**/transactions?*focus=set-category-selection*",
	slowSelectAll,
);
await page.getByRole("link", { name: /^Select all \d+$/ }).click();
await page.getByLabel("Search transactions").fill("Local Bakery");
// The search's list is the one that stays; the held Select all list it replaces must not come back once it is let go.
await page.waitForURL(/[?&]q=Local/);
await settleReplies();
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

// Select all pressed while its count is still loading, then a search typed before Select all's reply comes back (#471).
// Select all replaces the count, so its own request goes out at once; a search typed while that request is held must
// replace it, and its held reply must not land over the search. Both requests are held, and each wait is on the
// request's own effect, never a sleep.
errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
let heldCount = null;
let countHeld;
const countIsHeld = new Promise((resolve) => (countHeld = resolve));
const holdCount = (route) => {
	heldCount = route;
	countHeld();
};
await page.route("**/transactions/select/count*", holdCount);
await followLink(page.getByRole("link", { name: "Select" }));
await countIsHeld;
let heldSelectAll = null;
let selectAllHeld;
const selectAllIsHeld = new Promise((resolve) => (selectAllHeld = resolve));
const holdSelectAll = (route) => {
	heldSelectAll = route;
	selectAllHeld();
};
await page.route(
	"**/transactions?*focus=set-category-selection*",
	holdSelectAll,
);
await page.evaluate(() => {
	window.__selectAllEnded = false;
	document.addEventListener("htmx:finally:request", (event) => {
		if (
			event.detail.ctx.request.action.includes("focus=set-category-selection")
		)
			window.__selectAllEnded = true;
	});
});
await page.getByRole("link", { name: /^Select all \d+$/ }).click();
// Select all replaced the count in flight, so the count is already dropped; Select all's own request is the one held.
await heldCount.continue().catch(() => {}); // a count the page has already dropped can't be released, and needn't be
await selectAllIsHeld;
await page.getByLabel("Search transactions").fill("Local Bakery");
await page.waitForFunction(() => location.search.includes("q=Local"));
await heldSelectAll.continue().catch(() => {}); // the page may already have aborted it, as the search replaces it
await page.waitForFunction(() => window.__selectAllEnded);
assert.match(
	page.url(),
	/[?&]q=Local/,
	"the search must be the list that stays",
);
assert.equal(
	await page.locator("#selection-form input[name=ids]:checked").count(),
	0,
	"the Select all list must not come back ticked over the search",
);
await page.unroute("**/transactions/select/count*", holdCount);
await page.unroute(
	"**/transactions?*focus=set-category-selection*",
	holdSelectAll,
);
dropReplacedRequestLogs(errorsBefore);
step(
	"Select all with its count still loading, then a search: the search stays",
);

// A tick made while Select all's reply is held, then a search typed before that reply comes back (#471). A person can't
// tick during a list load (the rows are paused), so the tick is a change event the test sends. The tick's count queues
// behind Select all (or runs beside it, unpatched): the search must replace Select all's request either way, and Select
// all's held reply must not land over the search.
errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?uncategorized=1`, {
	waitUntil: "networkidle",
});
const tickHeldCounts = [];
let tickFirstCountHeld;
const tickFirstCountIsHeld = new Promise(
	(resolve) => (tickFirstCountHeld = resolve),
);
await page.route("**/transactions/select/count*", (route) => {
	tickHeldCounts.push(route);
	tickFirstCountHeld();
});
await followLink(page.getByRole("link", { name: "Select" }));
await tickFirstCountIsHeld;
let tickHeldSelectAll = null;
let tickSelectAllHeld;
const tickSelectAllIsHeld = new Promise(
	(resolve) => (tickSelectAllHeld = resolve),
);
await page.route("**/transactions?*focus=set-category-selection*", (route) => {
	tickHeldSelectAll = route;
	tickSelectAllHeld();
});
let tickHeldSearch = null;
let tickSearchHeld;
const tickSearchIsHeld = new Promise((resolve) => (tickSearchHeld = resolve));
await page.route("**/transactions?*q=Local*", (route) => {
	tickHeldSearch = route;
	tickSearchHeld();
});
await page.evaluate(() => {
	window.__searchEnded = false;
	window.__selectAllEnded = false;
	document.addEventListener("htmx:finally:request", (event) => {
		const { action } = event.detail.ctx.request;
		if (action.includes("q=Local")) window.__searchEnded = true;
		if (action.includes("focus=set-category-selection"))
			window.__selectAllEnded = true;
	});
});
await page.getByRole("link", { name: /^Select all \d+$/ }).click();
await tickSelectAllIsHeld;
await page.evaluate(() => {
	const box = document.querySelector("#selection-form input[name=ids]");
	box.checked = true;
	box.dispatchEvent(new Event("change", { bubbles: true }));
});
await page.getByLabel("Search transactions").fill("Local Bakery");
await tickSearchIsHeld;
await tickHeldSearch.continue();
await page.waitForFunction(() => window.__searchEnded);
await tickHeldSelectAll.continue().catch(() => {}); // a patched htmx has already aborted it, as the search replaced it
await page.waitForFunction(() => window.__selectAllEnded);
for (const route of tickHeldCounts) await route.continue().catch(() => {}); // a count the page dropped can't be released
assert.match(
	page.url(),
	/[?&]q=Local/,
	"the search must stay when a tick's count and Select all are still in flight",
);
await page.unroute("**/transactions/select/count*");
await page.unroute("**/transactions?*focus=set-category-selection*");
await page.unroute("**/transactions?*q=Local*");
dropReplacedRequestLogs(errorsBefore);
step("a tick made while Select all is held, then a search: the search stays");

// Next while a count is still loading: page 2 must get its own ids, not page 1's (#215).
errorsBefore = consoleErrors.length;
await goto(`${BASE}/transactions?month=all`, { waitUntil: "networkidle" });
await page.route("**/transactions/select/count*", slowCount);
await followLink(page.getByRole("link", { name: "Select" }));
await page.locator("#selection-form label:has(input[name=ids])").nth(0).click();
await page.getByRole("button", { name: "Older", exact: true }).click();
// The Next list replaces the count still in flight: settle waits for that count to be let go and for the list to land.
await settleReplies();
// The Next reply focuses the first tick on the frame after the list swaps in (toast.js), so its page-2 ids are in place.
await page.waitForFunction(
	() =>
		document.activeElement ===
		document.querySelector("#results input[name=ids]"),
);
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
await followLink(page.getByRole("link", { name: "Select" }));
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
await page.getByRole("button", { name: "Older", exact: true }).click();
// The slowed load marks the form while it runs; wait for that instead of a fixed pause.
await page.waitForSelector("#selection-form.htmx-request");
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
// A tap during the load has no reply to wait for (it must do nothing), so give one that got through a moment to show.
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
await page.getByRole("button", { name: "Newer", exact: true }).click();
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
// The filter waits out a 300ms debounce: wait for its slowed list to be in flight, so the next change lands on that load.
await page.waitForSelector("#selection-form.htmx-request");
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
await page.getByRole("button", { name: "Older", exact: true }).click();
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
await followLink(page.getByRole("link", { name: "Select" }));
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
// #600: every Budget box keeps its size and wraps, so How Tally works never scrolls sideways at 320px or 390px.
for (const width of [320, 390]) {
	await page.setViewportSize({ width, height: 844 });
	await goto(`${BASE}/how-it-works`, { waitUntil: "networkidle" });
	const scrollWidth = await page.evaluate(
		() => document.documentElement.scrollWidth,
	);
	assert(
		scrollWidth <= width,
		`How Tally works scrolls sideways at ${width}px: ${scrollWidth}px`,
	);
}
step("How Tally works doesn't scroll sideways at 320px or 390px");
// #600: the Budget diagram's boxes are the direct svg children of its labelled row. At 390px the column is 350px, so three
// boxes fill the first line and "= Safe to spend" wraps below Budget; at 1280px all of them share one line. Each width
// loads the page again, so what is measured doesn't depend on the loop above.
const budgetBoxes = page.locator(
	'[role="img"][aria-labelledby="budget-diagram-title"] > svg',
);
const budgetBoxTops = () =>
	budgetBoxes.evaluateAll((els) =>
		els.map((el) => {
			const r = el.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom };
		}),
	);
await page.setViewportSize({ width: 390, height: 844 });
await goto(`${BASE}/how-it-works`, { waitUntil: "networkidle" });
const phoneBoxes = await budgetBoxTops();
assert(
	phoneBoxes.length >= 4,
	`the Budget diagram has ${phoneBoxes.length} boxes at 390px, not 4 or more`,
);
assert(
	(await budgetBoxes.last().textContent()).includes("Safe to spend"),
	"the last Budget box at 390px is not = Safe to spend",
);
assert(
	phoneBoxes.at(-1).top > phoneBoxes[0].bottom,
	`= Safe to spend is on Budget's line at 390px (tops ${phoneBoxes.map((box) => box.top).join(", ")})`,
);
step("at 390px the Budget diagram puts = Safe to spend on a line below Budget");
await page.setViewportSize({ width: 1280, height: 800 });
await goto(`${BASE}/how-it-works`, { waitUntil: "networkidle" });
const desktopBoxes = await budgetBoxTops();
assert(
	desktopBoxes.length >= 4,
	`the Budget diagram has ${desktopBoxes.length} boxes at 1280px, not 4 or more`,
);
const desktopTops = desktopBoxes.map((box) => box.top);
assert(
	Math.max(...desktopTops) - Math.min(...desktopTops) <= 1,
	`the Budget boxes are not on one line at 1280px (tops ${desktopTops.join(", ")})`,
);
step("at 1280px every Budget box sits on one line");
// #500: on a 320px phone the notebook drawing is left out below 390px (decision 116), so a seven-character amount has the
// whole row and nothing scrolls sideways. Safe to spend moves one for one with this month's Groceries budget and savings
// goal, so each write moves it to the target shown; the demo reset below restores the data.
await page.setViewportSize({ width: 320, height: 844 });
await goto(`${BASE}/`, { waitUntil: "networkidle" });
const safeToSpend = page.locator("p.text-6xl").first();
await safeToSpend.waitFor();
// Home's own month, read from its Months navigation: the household's month in its own zone (decision 67), not the clock's.
const homeMonth = new URL(
	await page
		.locator('nav[aria-label="Months"] a[aria-current="page"]')
		.getAttribute("href"),
	BASE,
).searchParams.get("month");
assert.match(
	homeMonth ?? "",
	/^\d{4}-\d{2}$/,
	`Home's month is not YYYY-MM: ${homeMonth}`,
);
const shownDollars = (text) => {
	const match = text.match(/^([−-]?)\$([\d,]+)/);
	assert(match, `Home's Safe to spend shows no amount: ${text}`);
	return (match[1] ? -1 : 1) * Number(match[2].replaceAll(",", ""));
};
const shownAt = async () => shownDollars(await safeToSpend.textContent());
// The notebook drawing is the row's last child. For amounts of up to seven characters it is display none below 390px and
// block from 390px; longer amounts leave it out below 640px (decision 116).
const drawingDisplay = () =>
	safeToSpend.evaluate(
		(el) => getComputedStyle(el.closest("div.flex").lastElementChild).display,
	);
const assertNarrowPhone = async (amount, what) => {
	const text = await safeToSpend.textContent();
	assert(text.startsWith(amount), `${what}: Safe to spend shows ${text}`);
	assert.equal(
		await drawingDisplay(),
		"none",
		`${what}: the notebook drawing shows at 320px`,
	);
	const scrollWidth = await page.evaluate(
		() => document.documentElement.scrollWidth,
	);
	assert(
		scrollWidth <= 320,
		`${what} scrolls sideways at 320px: ${scrollWidth}px`,
	);
};
const shownStart = await shownAt();
writeLocalD1(
	`INSERT OR REPLACE INTO budget_amounts (category_id, effective_month, amount_cents) SELECT id, '${homeMonth}', COALESCE((SELECT amount_cents FROM budget_amounts WHERE category_id = categories.id AND effective_month <= '${homeMonth}' ORDER BY effective_month DESC LIMIT 1), 0) + ${(9999 - shownStart) * 100} FROM categories WHERE name = 'Groceries'`,
);
await goto(`${BASE}/`, { waitUntil: "networkidle" });
await safeToSpend.waitFor();
await assertNarrowPhone("$9,999", "Safe to spend at $9,999");
step(
	"at 320px Safe to spend shows $9,999 with the notebook drawing left out, and nothing scrolls sideways",
);
const shownHigh = await shownAt();
writeLocalD1(
	`INSERT OR REPLACE INTO savings_goal_amounts (effective_month, amount_cents) SELECT '${homeMonth}', COALESCE((SELECT amount_cents FROM savings_goal_amounts WHERE effective_month <= '${homeMonth}' ORDER BY effective_month DESC LIMIT 1), 0) + ${(shownHigh + 9999) * 100}`,
);
await goto(`${BASE}/`, { waitUntil: "networkidle" });
await safeToSpend.waitFor();
await assertNarrowPhone("−$9,999", "Safe to spend at −$9,999");
step(
	"at 320px Safe to spend shows −$9,999 with the notebook drawing left out, and nothing scrolls sideways",
);
await page.setViewportSize({ width: 390, height: 844 });
await goto(`${BASE}/`, { waitUntil: "networkidle" });
await safeToSpend.waitFor();
assert.equal(
	await drawingDisplay(),
	"block",
	"the notebook drawing is left out at 390px",
);
assert.equal(
	(await safeToSpend.textContent()).slice(0, 7),
	"−$9,999",
	"Safe to spend is not −$9,999 at 390px",
);
const [minusTop, dollarTop] = await safeToSpend.evaluate((el) => {
	const text = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
	const topOf = (start) => {
		const range = document.createRange();
		range.setStart(text, start);
		range.setEnd(text, start + 1);
		return range.getBoundingClientRect().top;
	};
	return [topOf(0), topOf(1)];
});
assert(
	Math.abs(minusTop - dollarTop) < 1,
	`the minus sign and the number are on different lines at 390px (tops ${minusTop} and ${dollarTop})`,
);
step(
	"at 390px the notebook drawing is back, and a negative Safe to spend keeps its minus sign on the number's line",
);
// #500 (P127 A, decision 116): −$19,999 is eight characters, and no eight-character amount fits beside the drawing with
// 8px to spare at any phone width up to 430px, so the drawing waits for 640px and the amount has the whole row. The
// savings goal rises by the gap from −$9,999 to −$19,999, the same write the steps above use.
const shownLow = await shownAt();
writeLocalD1(
	`INSERT OR REPLACE INTO savings_goal_amounts (effective_month, amount_cents) SELECT '${homeMonth}', COALESCE((SELECT amount_cents FROM savings_goal_amounts WHERE effective_month <= '${homeMonth}' ORDER BY effective_month DESC LIMIT 1), 0) + ${(shownLow + 19999) * 100}`,
);
await page.setViewportSize({ width: 390, height: 844 });
await goto(`${BASE}/`, { waitUntil: "networkidle" });
await safeToSpend.waitFor();
const eightText = await safeToSpend.textContent();
assert(
	eightText.startsWith("−$19,999"),
	`Safe to spend at 390px shows ${eightText}, not −$19,999`,
);
assert.equal(
	await drawingDisplay(),
	"none",
	"the notebook drawing shows beside a −$19,999 Safe to spend at 390px",
);
const eightRow = await safeToSpend.evaluate((el) => {
	const row = el.closest("div.flex");
	return { scroll: row.scrollWidth, client: row.clientWidth };
});
assert(
	eightRow.scroll <= eightRow.client,
	`the Safe to spend row overflows at 390px: ${eightRow.scroll}px needed in ${eightRow.client}px`,
);
const eightPageWidth = await page.evaluate(
	() => document.documentElement.scrollWidth,
);
assert(
	eightPageWidth <= 390,
	`−$19,999 scrolls sideways at 390px: ${eightPageWidth}px`,
);
step(
	"at 390px a −$19,999 Safe to spend leaves the notebook drawing out, and nothing scrolls sideways",
);
// #534: Organize's Save is disabled while it posts (hx-disable), so a double click files the group once and the
// question keeps its own address. Each Save is held for a moment, so the second click lands while the first is in flight.
await page.setViewportSize({ width: 390, height: 844 });
await goto(`${BASE}/transactions/organize`, { waitUntil: "networkidle" });
const organizeSaves = [];
const isOrganizeSave = (url) => url.pathname === "/transactions/organize";
const holdOrganizeSave = (route) => {
	if (route.request().method() !== "POST") return route.continue();
	organizeSaves.push(route.request().url());
	return holdReply(route, 400);
};
await page.route(isOrganizeSave, holdOrganizeSave);
await page.getByText("Groceries", { exact: true }).click();
await page.getByRole("button", { name: "Save and next" }).dblclick();
await until(() => organizeSaves.length >= 1, "the Save to reach the server");
await page.getByRole("heading", { name: /^Always use Groceries/ }).waitFor();
await settleReplies();
await settle();
assert.equal(organizeSaves.length, 1, "a double click sends one Save");
assert(
	new URL(page.url()).searchParams.has("store"),
	`the question keeps its own address: ${page.url()}`,
);
await page.unroute(isOrganizeSave);
step(
	"a double click on Organize's Save files the group once, and the question keeps its address",
);

// #610: the catalog's sheet drawings sit inside an inert frame, so they are not open sheets. Nothing is marked inert,
// Tab and Escape stay on the page, and the toasts keep their place above the tabs.
await goto(`${BASE}/design-system`, { waitUntil: "networkidle" });
assert.equal(
	await page.evaluate(
		() => document.querySelectorAll("[data-sheet-inert]").length,
	),
	0,
	"the catalog's sheet drawings marked the page inert",
);
await page.evaluate(() => document.activeElement?.blur());
await page.keyboard.press("Tab");
const catalogFocus = await page.evaluate(() => {
	const el = document.activeElement;
	return {
		onPage: !!el && el !== document.body && el !== document.documentElement,
		inert: !!el?.closest("[inert]"),
	};
});
assert(
	catalogFocus.onPage && !catalogFocus.inert,
	"Tab left focus on nothing, or on a drawing inside the inert frame",
);
await page.keyboard.press("Escape");
await settle();
assert.equal(
	new URL(page.url()).pathname,
	"/design-system",
	"Escape followed a drawing's backdrop away from the catalog",
);
// A fixed region's computed top and bottom are its used pixels, so the place is read from where its box sits: above the
// tabs, in the lower half of the phone, and not at the top edge where a sheet's toasts go.
const toastPlace = await page.evaluate(() => ({
	top: document.getElementById("toasts").getBoundingClientRect().top,
	viewport: innerHeight,
}));
assert(
	toastPlace.top > toastPlace.viewport / 2,
	`the toasts moved to the top edge: ${JSON.stringify(toastPlace)}`,
);
step(
	"the catalog's sheet drawings leave it usable: nothing inert, Tab and Escape stay on the page, toasts in their place",
);

// Without JavaScript Older, Newer and Add cash submit the selection form (#383), so a tick made on the page survives
// a page change, an untick does too, and Add cash's sheet gets the tick. This context has no JavaScript at all.
const plainContext = await browser.newContext({
	viewport: { width: 390, height: 844 },
	javaScriptEnabled: false,
	reducedMotion: "reduce",
});
const plain = await plainContext.newPage();
// On a phone the first row sits low, under the fixed selection bar, so it is centred before its tick is clicked.
const tickFirstRow = async (scope) => {
	const label = plain.locator(`${scope} label:has(input[name=ids])`).nth(0);
	await label.evaluate((element) =>
		element.scrollIntoView({ block: "center" }),
	);
	await label.click();
};
await plain.goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "load",
});
await tickFirstRow("#selection-form");
const tickedRowId = await plain
	.locator("#selection-form input[name=ids]")
	.nth(0)
	.getAttribute("value");
await plain.getByRole("button", { name: "Older", exact: true }).click();
await plain.waitForURL(/page=2/);
const countOnPageTwo = await plain.locator("#selected-count").textContent();
assert.ok(
	countOnPageTwo?.startsWith("1 selected"),
	`Older dropped the tick made on page 1: ${countOnPageTwo}`,
);
step("without JavaScript, Older keeps a tick made on the page");

await plain.locator("#not-on-page summary").click();
await tickFirstRow("#not-on-page");
await plain.getByRole("button", { name: "Newer", exact: true }).click();
await plain.waitForURL(/page=1/);
assert.equal(
	await plain.locator("#selected-count").textContent(),
	"Choose rows, then an action",
	"Newer brought back a tick that was unticked on page 2",
);
assert.equal(
	await plain.locator("#selection-form input[name=ids]").nth(0).isChecked(),
	false,
	"the row unticked on page 2 came back ticked on page 1",
);
step("without JavaScript, Newer keeps an untick made off the page");

await plain.goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "load",
});
await tickFirstRow("#selection-form");
await plain.getByRole("button", { name: "Add cash", exact: true }).click();
await plain.waitForURL(/\/transactions\/cash\/new/);
assert.ok(
	new URL(plain.url()).searchParams.getAll("ids").includes(tickedRowId),
	`Add cash's sheet dropped the tick: ${plain.url()}`,
);
step("without JavaScript, Add cash's sheet keeps the tick");

// Apply filters and Enter in the search box submit the selection form too (#383): a tick made on the page is kept, an
// untick is kept, and the search typed into the box is applied. Enter filters rather than opening Add cash's sheet.
await plain.goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "load",
});
await tickFirstRow("#selection-form");
const appliedId = await plain
	.locator("#selection-form input[name=ids]")
	.nth(0)
	.getAttribute("value");
await plain.getByRole("button", { name: "Apply filters", exact: true }).click();
await plain.waitForURL((url) =>
	url.searchParams.getAll("ids").includes(appliedId),
);
assert.ok(
	await plain.locator("#selection-form input[name=ids]").nth(0).isChecked(),
	"Apply filters dropped a tick made on the page",
);
step("without JavaScript, Apply filters keeps a tick made on the page");

await plain.goto(`${BASE}/transactions?month=all&select=1&ids=${appliedId}`, {
	waitUntil: "load",
});
await tickFirstRow("#selection-form");
await plain.getByRole("button", { name: "Apply filters", exact: true }).click();
await plain.waitForURL(
	(url) => !url.searchParams.getAll("ids").includes(appliedId),
);
assert.equal(
	await plain.locator("#selection-form input[name=ids]").nth(0).isChecked(),
	false,
	"Apply filters brought back a tick that was unticked on the page",
);
step("without JavaScript, Apply filters keeps an untick made on the page");

await plain.goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "load",
});
await plain.locator("#q").fill("zzz-no-match");
await plain.getByRole("button", { name: "Apply filters", exact: true }).click();
await plain.waitForURL((url) => url.searchParams.get("q") === "zzz-no-match");
assert.ok(
	await plain.getByText("No transactions match these filters.").isVisible(),
	"Apply filters dropped the search typed into the box",
);
step("without JavaScript, Apply filters applies the search typed into the box");

await plain.goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "load",
});
await plain.locator("#q").fill("zzz-no-match");
await plain.locator("#q").press("Enter");
await plain.waitForURL((url) => url.searchParams.get("q") === "zzz-no-match");
assert.ok(
	!plain.url().includes("/transactions/cash/new"),
	`Enter in the search box opened Add cash: ${plain.url()}`,
);
step("without JavaScript, Enter in the search box filters and opens no sheet");
await plainContext.close();

// With JavaScript, Enter in the search box filters the list in Select mode too, and opens no sheet (#383).
await goto(`${BASE}/transactions?month=all&select=1`, {
	waitUntil: "networkidle",
});
await page.locator("#q").fill("zzz-no-match");
// A window value a full page load would clear: Enter must filter in place, not submit the form natively.
await page.evaluate(() => {
	window.enterFiltersInPlace = true;
});
await page.locator("#q").press("Enter");
await page.waitForURL((url) => url.searchParams.get("q") === "zzz-no-match");
await page.getByText("No transactions match these filters.").waitFor();
assert.equal(
	await page.evaluate(() => window.enterFiltersInPlace),
	true,
	"Enter in the search box reloaded the page instead of filtering in place",
);
assert.equal(
	await page.locator('[role="dialog"]').count(),
	0,
	"Enter in the search box opened a sheet with JavaScript",
);
step(
	"with JavaScript, Enter in the search box filters in Select mode and opens no sheet",
);

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

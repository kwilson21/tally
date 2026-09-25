// Opens every page at desktop and phone size, saves a full-page PNG of each,
// and exits non-zero if any page logs a console error (spec §11 finish line: no console errors).
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { PAGES, VIEWPORTS } from "./pr-body.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
// OUT lets CI also screenshot the base branch into its own folder for before-and-after.
const OUT = process.env.OUT ?? "screenshots";

await mkdir(OUT, { recursive: true });
// CHROMIUM_PATH is only for machines with a preinstalled browser; CI installs Playwright's own.
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || undefined,
});
const errors = [];

for (const viewport of VIEWPORTS) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		reducedMotion: "reduce",
	});
	for (const page of PAGES) {
		const where = `${page.path} (${viewport.name})`;
		const tab = await context.newPage();
		tab.on("console", (message) => {
			if (message.type() === "error")
				errors.push(`${where}: ${message.text()}`);
		});
		tab.on("pageerror", (error) => errors.push(`${where}: ${error.message}`));
		const response = await tab.goto(BASE + page.path, {
			waitUntil: "networkidle",
		});
		if (!response?.ok()) errors.push(`${where}: HTTP ${response?.status()}`);
		// Retake until two shots in a row match, so a page caught mid-render doesn't count as a
		// change in the before-and-after comparison (#60).
		const shoot = () =>
			tab.screenshot({ fullPage: true, animations: "disabled" });
		let shot = await shoot();
		for (let tries = 0; tries < 5; tries++) {
			const again = await shoot();
			if (again.equals(shot)) break;
			shot = again;
		}
		await writeFile(`${OUT}/${page.name}-${viewport.name}.png`, shot);
		await tab.close();
	}
	await context.close();
}

await browser.close();
if (errors.length > 0) {
	console.error(`Console errors:\n${errors.join("\n")}`);
	process.exit(1);
}
console.log(`Saved ${PAGES.length * VIEWPORTS.length} screenshots to ${OUT}/`);

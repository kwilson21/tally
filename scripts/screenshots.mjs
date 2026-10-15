// Opens every page at desktop and phone size, saves a full-page PNG of each,
// and exits non-zero if any page logs a console error (spec §11 finish line: no console errors).
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { captureSlices, pageShooter, sliceBands } from "./capture.mjs";
import { PAGES, shotNames, VIEWPORTS } from "./pr-body.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
// OUT lets CI also screenshot the base branch into its own folder for before-and-after.
const OUT = process.env.OUT ?? "screenshots";

await mkdir(OUT, { recursive: true });
// CHROMIUM_PATH is only for machines with a preinstalled browser; CI installs Playwright's own.
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || undefined,
});
const errors = [];
const today = () => new Date().toISOString().slice(0, 10);
const started = today();
let saved = 0;

// The page's size in CSS pixels, measured the way Playwright measures a full-page capture.
function pageSize(tab) {
	return tab.evaluate(() => {
		const sides = [document.body, document.documentElement];
		return {
			width: Math.max(
				...sides.flatMap((el) => [
					el.scrollWidth,
					el.offsetWidth,
					el.clientWidth,
				]),
			),
			height: Math.max(
				...sides.flatMap((el) => [
					el.scrollHeight,
					el.offsetHeight,
					el.clientHeight,
				]),
			),
		};
	});
}

// A page too tall for one capture, taken as slices of at most SLICE_HEIGHT (#580). Each slice is a
// clip of the full page, in page pixels.
async function sliceShots(tab, where) {
	const size = await pageSize(tab);
	const bands = sliceBands(size.height);
	console.warn(`${where}: ${bands.length} slices, ${size.height}px tall.`);
	return captureSlices({
		label: where,
		bands,
		capture: (band) =>
			tab.screenshot({
				fullPage: true,
				animations: "disabled",
				clip: { x: 0, y: band.y, width: size.width, height: band.height },
			}),
	});
}

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
		if (!response?.ok()) {
			errors.push(`${where}: HTTP ${response?.status()}`);
			// An error page isn't the page: on the base branch this is a page the PR adds, so the
			// before-and-after marks it new instead of showing the error (#60).
			await tab.close();
			continue;
		}
		// Retake until two shots in a row match, so a page caught mid-render doesn't count as a
		// change in the before-and-after comparison (#60). A shot is a list of PNGs: the whole
		// page, or its slices when Chromium won't capture it whole (#580).
		const shoot = pageShooter({
			label: where,
			height: (await pageSize(tab)).height,
			whole: async () => [
				await tab.screenshot({ fullPage: true, animations: "disabled" }),
			],
			slices: () => sliceShots(tab, where),
		});
		let shots = await shoot();
		for (let tries = 0; tries < 5; tries++) {
			const again = await shoot();
			if (
				again.length === shots.length &&
				again.every((shot, i) => shot.equals(shots[i]))
			)
				break;
			shots = again;
		}
		const names = shotNames(page.name, viewport.name, shots.length);
		for (const [i, shot] of shots.entries())
			await writeFile(`${OUT}/${names[i]}`, shot);
		saved += shots.length;
		await tab.close();
	}
	await context.close();
}

await browser.close();
// Proof this run finished, with the UTC dates it ran on: the before-and-after only compares two
// finished runs from the same day, since the demo data follows the date (scripts/changed-shots.mjs).
await writeFile(
	`${OUT}/run.json`,
	JSON.stringify({ started, finished: today() }),
);
if (errors.length > 0) {
	console.error(`Console errors:\n${errors.join("\n")}`);
	process.exit(1);
}
console.log(`Saved ${saved} screenshots to ${OUT}/`);

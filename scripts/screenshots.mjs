// Opens every page at desktop and phone size and exits non-zero if any page logs a console error (spec §11
// finish line: no console errors). Alone, it saves a full-page PNG of every page into OUT. With BEFORE_URL
// (CI's base branch, served on its own port), it loads every page on both servers, fingerprints each load
// (scripts/fingerprint.mjs), and saves only the pages whose fingerprints differ: the PR's into OUT, and the
// base's into BEFORE_OUT (decision 152).
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { captureSlices, pageShooter, sliceBands } from "./capture.mjs";
import { fingerprintOf, needsCapture, sha256Hex } from "./fingerprint.mjs";
import { PAGES, shotNames, VIEWPORTS } from "./pr-body.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
// OUT holds the PR's shots. BEFORE_URL is the base branch's server, and its shots go to BEFORE_OUT.
const OUT = process.env.OUT ?? "screenshots";
const BEFORE_URL = process.env.BEFORE_URL;
const BEFORE_OUT = process.env.BEFORE_OUT ?? "screenshots-before";

await mkdir(OUT, { recursive: true });
if (BEFORE_URL) await mkdir(BEFORE_OUT, { recursive: true });
// CHROMIUM_PATH is a Chrome already on this machine. CI sets it to the runner's Google Chrome when that launches.
const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH || undefined,
});
const errors = [];
const today = () => new Date().toISOString().slice(0, 10);
const started = today();
const startedAt = Date.now();
let loaded = 0;
let captured = 0;
let saved = 0;
let savedBefore = 0;

// The assets a page's look depends on, as Playwright names their request types (decision 152).
const FINGERPRINTED = new Set(["stylesheet", "script", "font", "image"]);

// A promise of one asset's path and hash. A body that can't be read is hashed as the response's status
// instead, so the page still gets a fingerprint and a difference still shows.
function hashAsset(response, url) {
	const path = url.pathname + url.search;
	return response.body().then(
		async (body) => ({ path, sha256: await sha256Hex(body) }),
		() => ({ path, sha256: `status:${response.status()}` }),
	);
}

// Loads `url` in `tab` until the network is idle. With `fingerprint`, it also returns the page's
// fingerprint, taken once the fonts are ready: the DOM, and a hash of each same-origin stylesheet,
// script, font and image the page loaded. A page that isn't ok has no fingerprint. The response
// listener is set before goto, so it sees every asset.
async function load(tab, url, { fingerprint = false } = {}) {
	const { origin } = new URL(url);
	const hashes = [];
	if (fingerprint)
		tab.on("response", (response) => {
			const asset = new URL(response.url());
			if (
				asset.origin !== origin ||
				!FINGERPRINTED.has(response.request().resourceType())
			)
				return;
			hashes.push(hashAsset(response, asset));
		});
	const response = await tab.goto(url, { waitUntil: "networkidle" });
	if (!fingerprint || !response?.ok()) return { response };
	await tab.evaluate(async () => {
		await document.fonts.ready;
		return true;
	});
	const assets = (await Promise.allSettled(hashes)).flatMap((result) =>
		result.status === "fulfilled" ? [result.value] : [],
	);
	const dom = await tab.evaluate(() => document.documentElement.outerHTML);
	return { response, fingerprint: await fingerprintOf({ dom, assets }) };
}

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

// A loaded page's shots: retaken until two in a row match, so a page caught mid-render doesn't count as
// a change in the before-and-after comparison (#60). A shot is a list of PNGs: the whole page, or its
// slices when Chromium won't capture it whole (#580).
async function captureShots(tab, where) {
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
	return shots;
}

// Writes a page's shots into `dir` under the names shotNames gives them, and returns how many.
async function save(dir, page, viewport, shots) {
	const names = shotNames(page.name, viewport.name, shots.length);
	for (const [i, shot] of shots.entries())
		await writeFile(`${dir}/${names[i]}`, shot);
	return shots.length;
}

for (const viewport of VIEWPORTS) {
	const settings = {
		viewport: { width: viewport.width, height: viewport.height },
		reducedMotion: "reduce",
	};
	const context = await browser.newContext(settings);
	// The base branch's pages load in their own context, at the same size.
	const beforeContext = BEFORE_URL ? await browser.newContext(settings) : null;
	for (const page of PAGES) {
		const where = `${page.path} (${viewport.name})`;
		const tab = await context.newPage();
		// Only the PR's console and page errors count; the base's don't (screenshots.yml).
		tab.on("console", (message) => {
			if (message.type() === "error")
				errors.push(`${where}: ${message.text()}`);
		});
		tab.on("pageerror", (error) => errors.push(`${where}: ${error.message}`));
		const beforeTab = beforeContext ? await beforeContext.newPage() : null;
		loaded++;
		// Both servers at once, so the two loads are seconds apart (decision 152).
		const [head, base] = beforeTab
			? await Promise.all([
					load(tab, BASE + page.path, { fingerprint: true }),
					load(beforeTab, BEFORE_URL + page.path, { fingerprint: true }),
				])
			: [await load(tab, BASE + page.path), null];
		if (!head.response?.ok()) {
			errors.push(`${where}: HTTP ${head.response?.status()}`);
			// An error page isn't the page: on the base branch this is a page the PR adds, so the
			// before-and-after marks it new instead of showing the error (#60).
			await tab.close();
			await beforeTab?.close();
			continue;
		}
		if (!beforeTab) {
			saved += await save(OUT, page, viewport, await captureShots(tab, where));
			captured++;
		} else {
			const baseOk = base.response?.ok() ?? false;
			if (
				needsCapture({
					head: { ok: true, fingerprint: head.fingerprint },
					base: { ok: baseOk, fingerprint: base.fingerprint },
				})
			) {
				console.log(`${where}: ${baseOk ? "changed" : "new"}`);
				saved += await save(
					OUT,
					page,
					viewport,
					await captureShots(tab, where),
				);
				if (baseOk)
					savedBefore += await save(
						BEFORE_OUT,
						page,
						viewport,
						await captureShots(beforeTab, `${where} on main`),
					);
				captured++;
			}
		}
		await tab.close();
		await beforeTab?.close();
	}
	await context.close();
	await beforeContext?.close();
}

await browser.close();
// Proof this run finished, with the UTC dates it ran on: the before-and-after only compares two
// finished runs from the same day, since the demo data follows the date (scripts/changed-shots.mjs).
const run = JSON.stringify({ started, finished: today() });
await writeFile(`${OUT}/run.json`, run);
if (BEFORE_URL) await writeFile(`${BEFORE_OUT}/run.json`, run);
const seconds = Math.round((Date.now() - startedAt) / 1000);
console.log(
	`Loaded ${loaded} pages (each at each size), captured ${captured}, in ${seconds}s.`,
);
if (errors.length > 0) {
	console.error(`Console errors:\n${errors.join("\n")}`);
	process.exit(1);
}
console.log(
	BEFORE_URL
		? `Saved ${saved} screenshots to ${OUT}/ and ${savedBefore} to ${BEFORE_OUT}/`
		: `Saved ${saved} screenshots to ${OUT}/`,
);

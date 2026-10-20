// Compares this PR's screenshots (screenshots/) with the base branch's (screenshots-before/).
// Writes screenshots/changes.json and stages the images the description shows in screenshots/shown/,
// laid out as on the screenshots branch (before images in before/).
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { changedShots, comparisonProblem, shownFiles } from "./pr-body.mjs";

const AFTER = "screenshots";
const BEFORE = "screenshots-before";

const read = (path) => readFile(path).catch(() => null);
const runOf = async (dir) => {
	const run = await read(`${dir}/run.json`);
	return run ? JSON.parse(run.toString()) : null;
};
const after = await runOf(AFTER);
if (!after)
	throw new Error(
		`${AFTER}/run.json is missing: the PR's screenshots didn't finish.`,
	);
const unavailable = comparisonProblem(after, await runOf(BEFORE));

const listed = async (dir) =>
	(await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".png"));
const readShots = (dir, names) =>
	Promise.all(
		names.map(async (file) => ({
			file,
			png: await readFile(`${dir}/${file}`),
		})),
	);

const files = await listed(AFTER);
const changes = unavailable
	? []
	: await changedShots({
			after: await readShots(AFTER, files),
			before: await readShots(BEFORE, await listed(BEFORE)),
		});

// The images the description shows, laid out as on the screenshots branch. The folder must exist
// even when nothing is shown: the workflow copies it.
const shown = shownFiles(changes);
await mkdir(`${AFTER}/shown/before`, { recursive: true });
for (const file of shown.before)
	await copyFile(`${BEFORE}/${file}`, `${AFTER}/shown/before/${file}`);
for (const file of shown.after)
	await copyFile(`${AFTER}/${file}`, `${AFTER}/shown/${file}`);
await writeFile(
	`${AFTER}/changes.json`,
	JSON.stringify({ changes, unavailable }),
);
console.log(
	unavailable ??
		`${changes.length} changed rows (pages, or slices of a page) among ${files.length} screenshots.`,
);

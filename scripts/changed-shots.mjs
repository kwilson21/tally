// Compares this PR's screenshots (screenshots/) with the base branch's (screenshots-before/).
// Writes screenshots/changes.json and copies each changed image's "before" into screenshots/before/.
import {
	copyFile,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { changedShots } from "./pr-body.mjs";

const AFTER = "screenshots";
const BEFORE = "screenshots-before";

const read = (path) => readFile(path).catch(() => null);
const files = (await readdir(AFTER)).filter((f) => f.endsWith(".png"));
const changes = changedShots(
	await Promise.all(
		files.map(async (file) => ({
			file,
			after: await readFile(`${AFTER}/${file}`),
			before: await read(`${BEFORE}/${file}`),
		})),
	),
);

await mkdir(`${AFTER}/before`, { recursive: true });
for (const { file, hasBefore } of changes)
	if (hasBefore) await copyFile(`${BEFORE}/${file}`, `${AFTER}/before/${file}`);
await writeFile(`${AFTER}/changes.json`, JSON.stringify(changes));
console.log(
	`${changes.length} of ${files.length} screenshots differ from the base.`,
);

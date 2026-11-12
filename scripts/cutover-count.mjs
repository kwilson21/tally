// Prints the back-end cutover countdown from docs/write-handlers.json (decision 187):
// the headline and the per-area rows ROADMAP.md shows. Exempt handlers are not counted.
import { readFileSync } from "node:fs";

const { handlers } = JSON.parse(
	readFileSync(new URL("../docs/write-handlers.json", import.meta.url), "utf8"),
);

const todo = handlers.filter((h) => h.status !== "exempt");
const left = (list) => list.filter((h) => h.status === "legacy").length;

console.log(
	`Back-end cutover: ${left(todo)} of ${todo.length} handlers remain`,
);

console.log("");

console.log("| Area | Remaining | Handlers |");

console.log("|---|---|---|");

for (const area of [...new Set(todo.map((h) => h.area))].sort()) {
	const mine = todo.filter((h) => h.area === area);
	console.log(`| ${area} | ${left(mine)} | ${mine.length} |`);
}

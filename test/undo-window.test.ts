import { describe, expect, it } from "vitest";
import { UNDO_MS, UNDO_SECONDS, undoLeftMs, undoWords } from "../src/undo";
import { present } from "./helpers/present";

// How long an Undo stays open is written once, in src/undo.ts. The server's checks, the words a person reads and the
// toast's countdown (public/js/toast.js and the CSS token) all follow it: a toast that says "10 seconds" over a window
// of 5 shows the wrong words (audit finding).

const SOURCES = Object.entries(
	import.meta.glob("../src/**/*.{ts,tsx}", {
		query: "?raw",
		import: "default",
		eager: true,
	}),
).filter(
	([file]) => !file.includes("/design-system/") && !file.endsWith("/undo.ts"),
);

const TOAST = present(
	Object.values(
		import.meta.glob("../public/js/toast.js", {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	)[0],
);

const APP_CSS = present(
	Object.values(
		import.meta.glob("../src/styles/app.css", {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	)[0],
);

/** A whole-line comment is not code. */
const codeLines = (text: string) =>
	text.split("\n").filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line));

describe("the Undo window", () => {
	it("is a whole number of seconds", () => {
		expect(UNDO_MS % 1000).toBe(0);
		expect(UNDO_SECONDS).toBe(UNDO_MS / 1000);
		expect(UNDO_SECONDS).toBeGreaterThan(0);
	});

	it("says its length in the words a person reads", () => {
		expect(undoWords("Plan deleted.")).toBe(
			`Plan deleted. Undo for ${UNDO_SECONDS} seconds.`,
		);
	});

	it("leaves the time left: all of it at the start, none once it has run out, never more than the window", () => {
		expect(undoLeftMs(1000, 1000)).toBe(UNDO_MS);
		expect(undoLeftMs(1000, 1000 + UNDO_MS)).toBe(0);
		expect(undoLeftMs(1000, 1000 + UNDO_MS + 5)).toBe(0);
		expect(undoLeftMs(1000, 1000 + 4000)).toBe(UNDO_MS - 4000);
		expect(undoLeftMs(2000, 1000)).toBe(UNDO_MS);
	});

	it("is not spelled as a number or as words anywhere else in src: no Undo file, line or message repeats it", () => {
		const offenders: string[] = [];

		for (const [file, text] of SOURCES)
			for (const line of codeLines(text)) {
				const aboutUndo = /undo/i.test(file) || /undo/i.test(line);

				const undoConstant = /\bconst\s+(\w*UNDO\w*)\s*=\s*[\d_]+\s*;/.exec(
					line,
				);

				if (
					(aboutUndo && /\b10_?000\b/.test(line)) ||
					/Undo for \d+ seconds/i.test(line) ||
					(undoConstant && !undoConstant[1]?.includes("MIN"))
				)
					offenders.push(
						`${file.replace("../", "")}: ${line.trim().slice(0, 90)}`,
					);
			}

		expect(offenders).toEqual([]);
	});

	it("is the toast's own cap, in public/js/toast.js", () => {
		const written = UNDO_MS.toLocaleString("en-US").replaceAll(",", "_");
		expect(TOAST).toMatch(new RegExp(`const UNDO_MAX_MS = ${written};`));
		expect(TOAST).not.toMatch(/Math\.min\(\s*\d/);
	});

	it("is the countdown's length in app.css", () => {
		expect(APP_CSS).toMatch(
			new RegExp(`--duration-undo-toast:\\s*${UNDO_SECONDS}s;`),
		);
	});

	it("matches the prose that says 'ten seconds' (rule descriptions); change those words with the window", () => {
		// Not the Workflow's retry delay, which is another ten seconds.
		const OTHER = ["/sort-instance.ts", "/sort-groups.ts"];
		const prose: string[] = [];

		for (const [file, text] of SOURCES)
			if (!OTHER.some((o) => file.endsWith(o)))
				for (const line of text.split("\n"))
					if (/\b(?:ten|10) seconds\b/i.test(line))
						prose.push(
							`${file.replace("../", "")}: ${line.trim().slice(0, 90)}`,
						);
		expect(prose.length === 0 || UNDO_SECONDS === 10, prose.join("\n")).toBe(
			true,
		);
	});
});

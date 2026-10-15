import { describe, expect, it } from "vitest";
import { captureWithRetries, sliceBands } from "../scripts/capture.mjs";

// Retries never wait for real: each test passes a no-op wait and collects the log lines.
function harness() {
	const logs: string[] = [];
	const waits: number[] = [];
	return {
		logs,
		waits,
		options: {
			wait: async (ms: number) => {
				waits.push(ms);
			},
			log: (line: string) => {
				logs.push(line);
			},
		},
	};
}

const FAILURE = new Error("Unable to capture screenshot");

describe("captureWithRetries", () => {
	it("retries a failed capture, logging the page and attempt, and returns the one that works", async () => {
		const run = harness();
		let calls = 0;
		let fallbacks = 0;
		const result = await captureWithRetries({
			label: "/design-system/proposals (phone)",
			capture: async () => {
				calls += 1;
				if (calls === 1) throw FAILURE;
				return "full page";
			},
			fallback: async () => {
				fallbacks += 1;
				return "slices";
			},
			...run.options,
		});
		expect(result).toBe("full page");
		expect(calls).toBe(2);
		expect(fallbacks).toBe(0);
		expect(run.waits).toEqual([1000]);
		expect(run.logs).toHaveLength(1);
		expect(run.logs[0]).toContain("/design-system/proposals (phone)");
		expect(run.logs[0]).toContain("attempt 1 of 3");
	});

	it("takes the fallback once every try fails, and says so", async () => {
		const run = harness();
		let calls = 0;
		let fallbacks = 0;
		const result = await captureWithRetries({
			label: "/design-system/proposals (desktop)",
			capture: async () => {
				calls += 1;
				throw FAILURE;
			},
			fallback: async () => {
				fallbacks += 1;
				return "slices";
			},
			...run.options,
		});
		expect(result).toBe("slices");
		expect(calls).toBe(3);
		expect(fallbacks).toBe(1);
		expect(run.waits).toEqual([1000, 2000]);
		expect(run.logs.at(-1)).toContain("/design-system/proposals (desktop)");
		expect(run.logs.at(-1)).toContain("in slices");
	});
});

describe("sliceBands", () => {
	it("covers a tall page in bands of at most the slice height, the last one shorter", () => {
		expect(sliceBands(363000, 16000)).toHaveLength(23);
		expect(sliceBands(363000, 16000).at(-1)).toEqual({
			y: 352000,
			height: 11000,
		});
	});

	it("gives a page shorter than one slice a single band", () => {
		expect(sliceBands(800, 16000)).toEqual([{ y: 0, height: 800 }]);
	});

	it("never makes an empty band when the height is a whole number of slices", () => {
		expect(sliceBands(32000, 16000)).toEqual([
			{ y: 0, height: 16000 },
			{ y: 16000, height: 16000 },
		]);
	});
});

import { describe, expect, it } from "vitest";
import {
	captureSlices,
	captureWithRetries,
	pageShooter,
	SLICE_HEIGHT,
	sliceBands,
} from "../scripts/capture.mjs";

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

	it("rethrows the last error when every try fails and there is no fallback, and never says it is taken in slices", async () => {
		const run = harness();
		let calls = 0;
		await expect(
			captureWithRetries({
				label: "/design-system/proposals (desktop)",
				capture: async () => {
					calls += 1;
					throw FAILURE;
				},
				...run.options,
			}),
		).rejects.toBe(FAILURE);
		expect(calls).toBe(3);
		expect(run.waits).toEqual([1000, 2000]);
		expect(run.logs.some((line) => line.includes("in slices"))).toBe(false);
	});
});

describe("captureSlices", () => {
	const bands = [
		{ y: 0, height: 16000 },
		{ y: 16000, height: 16000 },
		{ y: 32000, height: 4000 },
	];

	it("retries a slice that fails once, returns the slices in band order, and logs the slice and attempt", async () => {
		const run = harness();
		const taken: number[] = [];
		let failed = false;
		const shots = await captureSlices({
			label: "/design-system/proposals (phone)",
			bands,
			capture: async (band) => {
				taken.push(band.y);
				if (band.y === 16000 && !failed) {
					failed = true;
					throw FAILURE;
				}
				return `slice at ${band.y}`;
			},
			...run.options,
		});
		expect(shots).toEqual(["slice at 0", "slice at 16000", "slice at 32000"]);
		expect(taken).toHaveLength(4);
		expect(run.waits).toEqual([1000]);
		expect(run.logs).toHaveLength(1);
		expect(run.logs[0]).toContain("slice 2 of 3");
		expect(run.logs[0]).toContain("attempt 1 of 3");
		expect(run.logs.some((line) => line.includes("in slices"))).toBe(false);
	});

	it("rejects with the error once a slice keeps failing, and captures no slice after it", async () => {
		const run = harness();
		const taken: number[] = [];
		await expect(
			captureSlices({
				label: "/design-system/proposals (phone)",
				bands,
				capture: async (band) => {
					taken.push(band.y);
					if (band.y === 16000) throw FAILURE;
					return `slice at ${band.y}`;
				},
				...run.options,
			}),
		).rejects.toBe(FAILURE);
		expect(taken).toEqual([0, 16000, 16000, 16000]);
		expect(run.waits).toEqual([1000, 2000]);
	});
});

describe("pageShooter", () => {
	it("takes a page whole until its whole-page tries have all failed, then goes straight to its slices", async () => {
		const run = harness();
		let wholeCalls = 0;
		let sliceCalls = 0;
		const shoot = pageShooter({
			label: "/design-system/proposals (phone)",
			whole: async () => {
				wholeCalls += 1;
				throw FAILURE;
			},
			slices: async () => {
				sliceCalls += 1;
				return ["a", "b"];
			},
			...run.options,
		});
		expect(await shoot()).toEqual(["a", "b"]);
		expect(wholeCalls).toBe(3);
		const logsAfterFirst = run.logs.length;
		expect(await shoot()).toEqual(["a", "b"]);
		expect(wholeCalls).toBe(3);
		expect(run.logs).toHaveLength(logsAfterFirst);
		expect(sliceCalls).toBe(2);
	});

	it("never slices a page whose whole-page capture works", async () => {
		const run = harness();
		let sliceCalls = 0;
		const shoot = pageShooter({
			label: "/settings (desktop)",
			whole: async () => ["whole"],
			slices: async () => {
				sliceCalls += 1;
				return ["a", "b"];
			},
			...run.options,
		});
		expect(await shoot()).toEqual(["whole"]);
		expect(sliceCalls).toBe(0);
	});

	it("never tries a page taller than one slice whole, since Chromium repeats its top in a whole capture that tall", async () => {
		const run = harness();
		let wholeCalls = 0;
		let sliceCalls = 0;
		const shoot = pageShooter({
			label: "/design-system/proposals (desktop)",
			height: 270694,
			whole: async () => {
				wholeCalls += 1;
				return ["whole"];
			},
			slices: async () => {
				sliceCalls += 1;
				return ["a", "b"];
			},
			...run.options,
		});
		expect(await shoot()).toEqual(["a", "b"]);
		expect(await shoot()).toEqual(["a", "b"]);
		expect(wholeCalls).toBe(0);
		expect(sliceCalls).toBe(2);
		expect(run.logs).toHaveLength(0);
	});

	it("tries a page exactly one slice tall whole, and slices one pixel taller", async () => {
		const run = harness();
		let wholeCalls = 0;
		let sliceCalls = 0;
		const shootWhole = pageShooter({
			label: "/settings (desktop)",
			height: SLICE_HEIGHT,
			whole: async () => {
				wholeCalls += 1;
				return ["whole"];
			},
			slices: async () => {
				sliceCalls += 1;
				return ["a", "b"];
			},
			...run.options,
		});
		expect(await shootWhole()).toEqual(["whole"]);
		expect(wholeCalls).toBe(1);
		expect(sliceCalls).toBe(0);
		const shootSliced = pageShooter({
			label: "/settings (desktop)",
			height: SLICE_HEIGHT + 1,
			whole: async () => {
				wholeCalls += 1;
				return ["whole"];
			},
			slices: async () => {
				sliceCalls += 1;
				return ["a", "b"];
			},
			...run.options,
		});
		expect(await shootSliced()).toEqual(["a", "b"]);
		expect(wholeCalls).toBe(1);
		expect(sliceCalls).toBe(1);
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

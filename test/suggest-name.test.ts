import { describe, expect, it, vi } from "vitest";
import {
	cleanSuggestedNames,
	NAME_MODEL,
	suggestNames,
} from "../src/ai/suggest-name";

// Workers AI suggests up to three names for a bank's text (spec §7, #33). Code decides what a
// usable name is: the model's words are only ever candidates.

const RAW = "SQ *BLUE BOTTLE COF 0412";

describe("cleanSuggestedNames", () => {
	it("keeps up to three names, one per line, best first", () => {
		expect(
			cleanSuggestedNames(
				"Blue Bottle Coffee\nBlue Bottle\nBlue Bottle Cafe\nBottle Blue",
				RAW,
			),
		).toEqual(["Blue Bottle Coffee", "Blue Bottle", "Blue Bottle Cafe"]);
	});

	it("trims, and strips list marks, numbering and quotes", () => {
		expect(
			cleanSuggestedNames(
				'  1. "Blue Bottle Coffee"  \n- Blue Bottle\n• “Blue Bottle Cafe”',
				RAW,
			),
		).toEqual(["Blue Bottle Coffee", "Blue Bottle", "Blue Bottle Cafe"]);
	});

	it("drops a name that is empty, too short or too long", () => {
		expect(
			cleanSuggestedNames(`A\n${"x".repeat(41)}\n${"y".repeat(40)}`, RAW),
		).toEqual(["y".repeat(40)]);
	});

	it("drops names with amounts, store numbers or codes in them, and ones that read as sentences", () => {
		expect(
			cleanSuggestedNames(
				[
					"Blue Bottle $6.50",
					"Blue Bottle 6.50",
					"Blue Bottle #0412",
					"Blue Bottle 0412",
					"Blue Bottle *COF",
					"Here is the name you asked for: Blue Bottle",
					"Blue Bottle Coffee Roasters Of Oakland California",
					"Blue Bottle Coffee",
				].join("\n"),
				RAW,
			),
		).toEqual(["Blue Bottle Coffee"]);
	});

	it("keeps a number that is part of a name", () => {
		expect(
			cleanSuggestedNames("7-Eleven\nPier 39\nMotel 6", "7-ELEVEN 3321"),
		).toEqual(["7-Eleven", "Pier 39", "Motel 6"]);
	});

	it("drops a name that is only the bank's text again, or its tidied form", () => {
		expect(
			cleanSuggestedNames(
				"SQ *BLUE BOTTLE COF 0412\nBlue bottle cof\nblue bottle cof\nBlue Bottle Coffee",
				RAW,
			),
		).toEqual(["Blue Bottle Coffee"]);
	});

	it("drops repeats, ignoring capitals", () => {
		expect(
			cleanSuggestedNames(
				"Blue Bottle\nBLUE BOTTLE\nblue bottle\nBlue Bottle Cafe",
				RAW,
			),
		).toEqual(["Blue Bottle", "Blue Bottle Cafe"]);
	});

	it("drops anything that isn't text, or looks like a link or markup", () => {
		expect(cleanSuggestedNames(undefined, RAW)).toEqual([]);
		expect(cleanSuggestedNames(42, RAW)).toEqual([]);
		expect(cleanSuggestedNames({ response: "Blue Bottle" }, RAW)).toEqual([]);
		expect(
			cleanSuggestedNames(
				"https://bluebottle.com\n<b>Blue Bottle</b>\nBlue Bottle Coffee",
				RAW,
			),
		).toEqual(["Blue Bottle Coffee"]);
	});
});

describe("suggestNames", () => {
	const fakeAi = (run: (...args: unknown[]) => unknown) =>
		({ run: vi.fn(run) }) as unknown as Ai & { run: ReturnType<typeof vi.fn> };

	it("asks the model once, with only the bank's text, and returns the cleaned names", async () => {
		const ai = fakeAi(async () => ({
			response: "Blue Bottle Coffee\nBlue Bottle",
		}));
		const result = await suggestNames(ai, RAW);
		expect(result).toEqual({
			ok: true,
			names: ["Blue Bottle Coffee", "Blue Bottle"],
		});
		expect(ai.run).toHaveBeenCalledTimes(1);
		const [model, input] = ai.run.mock.calls[0] as [
			string,
			{ messages: { role: string; content: string }[] },
		];
		expect(model).toBe(NAME_MODEL);
		const sent = JSON.stringify(input);
		expect(sent).toContain(RAW);
		// Nothing about the transaction beyond the bank's text goes along.
		expect(Object.keys(input).sort()).toEqual([
			"max_tokens",
			"messages",
			"temperature",
		]);
	});

	it("is ok with no names when none was usable, so the merchant isn't asked again", async () => {
		const ai = fakeAi(async () => ({ response: "BLUE BOTTLE COF" }));
		expect(await suggestNames(ai, "BLUE BOTTLE COF")).toEqual({
			ok: true,
			names: [],
		});
	});

	it("reports a failure when the model errors or answers with nothing to read", async () => {
		const boom = fakeAi(async () => {
			throw new Error("AiError: 3040: capacity temporarily exceeded");
		});
		expect(await suggestNames(boom, RAW)).toEqual({ ok: false });
		const empty = fakeAi(async () => ({}));
		expect(await suggestNames(empty, RAW)).toEqual({ ok: false });
		const odd = fakeAi(async () => "Blue Bottle Coffee");
		expect(await suggestNames(odd, RAW)).toEqual({
			ok: true,
			names: ["Blue Bottle Coffee"],
		});
	});

	it("logs the error's name only, never the bank's text or the model's words", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const ai = fakeAi(async () => {
			throw Object.assign(new Error(`failed for ${RAW}`), { name: "AiError" });
		});
		await suggestNames(ai, RAW);
		expect(logged).toHaveBeenCalledTimes(1);
		const line = String(logged.mock.calls[0]?.join(" "));
		expect(line).toContain("AiError");
		expect(line).not.toContain("BLUE BOTTLE");
		logged.mockRestore();
	});
});

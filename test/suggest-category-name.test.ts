import { describe, expect, it, vi } from "vitest";
import {
	cleanCategoryName,
	NAME_MODEL,
	suggestCategoryName,
} from "../src/ai/suggest-name";

// Workers AI proposes one name for a group of transactions no category fit (spec §7, #51). Code decides
// whether the name is usable: the model's words are only ever a candidate, and a person decides.

const HAVE = ["Groceries", "Eating Out", "Gas", "Kids", "Household"];

describe("cleanCategoryName", () => {
	it("takes the first usable line, trimmed", () => {
		expect(cleanCategoryName("  Subscriptions  \nStreaming", HAVE)).toBe(
			"Subscriptions",
		);
	});

	it("strips list marks, numbering, quotes and a closing full stop", () => {
		expect(cleanCategoryName('1. "Pet Care".', HAVE)).toBe("Pet Care");
		expect(cleanCategoryName("- “Pet Care”", HAVE)).toBe("Pet Care");
	});

	it("gives no name for an answer that is empty, or says there isn't one", () => {
		for (const answer of ["", "   ", "None", "nothing", "N/A", "none."])
			expect(cleanCategoryName(answer, HAVE)).toBeNull();
	});

	it("gives no name for anything that isn't text", () => {
		expect(cleanCategoryName(undefined, HAVE)).toBeNull();
		expect(cleanCategoryName(42, HAVE)).toBeNull();
		expect(cleanCategoryName({ response: "Pet Care" }, HAVE)).toBeNull();
	});

	it("keeps a name of two to 30 characters and at most three words", () => {
		expect(cleanCategoryName("A", HAVE)).toBeNull();
		expect(cleanCategoryName("x".repeat(31), HAVE)).toBeNull();
		expect(cleanCategoryName("Home Garden Pet Care Supplies", HAVE)).toBeNull();
		expect(cleanCategoryName("Pet Care Items", HAVE)).toBe("Pet Care Items");
	});

	it("drops a name with an amount, a code, a link or markup, or one that reads as a sentence", () => {
		for (const answer of [
			"Pet Care $20",
			"Pet Care 20.50",
			"Store #0412",
			"Pet 12345",
			"https://petcare.example",
			"<b>Pet Care</b>",
			"Here is a name: Pet Care",
		])
			expect(cleanCategoryName(answer, HAVE)).toBeNull();
	});

	it("keeps an ampersand or a hyphen, as the default categories have", () => {
		expect(cleanCategoryName("Home & Garden", HAVE)).toBe("Home & Garden");
		expect(cleanCategoryName("Day-care", HAVE)).toBe("Day-care");
	});

	it("never repeats a category the household has, whatever the capitals", () => {
		expect(cleanCategoryName("Groceries", HAVE)).toBeNull();
		expect(cleanCategoryName("eating out", HAVE)).toBeNull();
		// The first line is used up, so the next one is tried.
		expect(cleanCategoryName("GAS\nPet Care", HAVE)).toBe("Pet Care");
	});

	it("never offers Tally's own extra option as a category", () => {
		expect(cleanCategoryName("None of these fit", HAVE)).toBeNull();
		expect(cleanCategoryName("none of these fit\nPet Care", HAVE)).toBe(
			"Pet Care",
		);
	});

	it("capitalizes a name the model wrote all in lower or upper case", () => {
		expect(cleanCategoryName("pet care", HAVE)).toBe("Pet Care");
		expect(cleanCategoryName("PET CARE", HAVE)).toBe("Pet Care");
		expect(cleanCategoryName("Pet care", HAVE)).toBe("Pet care");
	});
});

describe("suggestCategoryName", () => {
	const fakeAi = (run: (...args: unknown[]) => unknown) =>
		({ run: vi.fn(run) }) as unknown as Ai & { run: ReturnType<typeof vi.fn> };
	const MERCHANTS = ["Chewy", "Petsmart", "Banfield Pet Hospital"];

	it("asks the model once with the merchants' names and the categories to avoid, and returns the cleaned name", async () => {
		const ai = fakeAi(async () => ({ response: "Pet Care" }));
		expect(await suggestCategoryName(ai, MERCHANTS, HAVE)).toEqual({
			ok: true,
			name: "Pet Care",
		});
		expect(ai.run).toHaveBeenCalledTimes(1);
		const [model, input] = ai.run.mock.calls[0] as [
			string,
			{ messages: { role: string; content: string }[] },
		];
		expect(model).toBe(NAME_MODEL);
		const sent = JSON.stringify(input);
		for (const word of [...MERCHANTS, ...HAVE]) expect(sent).toContain(word);
		// Nothing about the transactions beyond who was paid goes along: no amount, date, account or note.
		expect(Object.keys(input).sort()).toEqual([
			"max_tokens",
			"messages",
			"temperature",
		]);
	});

	it("is ok with no name when none was usable, so the group isn't asked about again", async () => {
		const ai = fakeAi(async () => ({ response: "Groceries" }));
		expect(await suggestCategoryName(ai, MERCHANTS, HAVE)).toEqual({
			ok: true,
			name: null,
		});
	});

	it("reports a failure when the model errors or answers with nothing to read", async () => {
		const boom = fakeAi(async () => {
			throw new Error("AiError: 3040: capacity temporarily exceeded");
		});
		expect(await suggestCategoryName(boom, MERCHANTS, HAVE)).toEqual({
			ok: false,
		});
		const empty = fakeAi(async () => ({}));
		expect(await suggestCategoryName(empty, MERCHANTS, HAVE)).toEqual({
			ok: false,
		});
	});

	it("logs the error's name only, never a merchant or the model's words", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const ai = fakeAi(async () => {
			throw Object.assign(new Error("failed for Chewy"), { name: "AiError" });
		});
		await suggestCategoryName(ai, MERCHANTS, HAVE);
		expect(logged).toHaveBeenCalledTimes(1);
		const line = String(logged.mock.calls[0]?.join(" "));
		expect(line).toContain("AiError");
		expect(line).not.toContain("Chewy");
		logged.mockRestore();
	});

	it("gives each request its own timeout, as the names call does", async () => {
		const ai = fakeAi(async () => ({ response: "Pet Care" }));
		await suggestCategoryName(ai, MERCHANTS, HAVE);
		await suggestCategoryName(ai, MERCHANTS, HAVE);
		const signals = ai.run.mock.calls.map(
			(call) => (call[2] as { signal?: AbortSignal } | undefined)?.signal,
		);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[1]).toBeInstanceOf(AbortSignal);
		expect(signals[1]).not.toBe(signals[0]);
	});
});

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { groupHasRule } from "../src/transactions/organize";

// groupHasRule's answers over a matrix of key lists (decision 209, #1140). Each row is the label of what was asked and
// the answer the function gave. The rows were recorded from the code before its query was made one statement, and
// the answers must not change.

const db = env.DB;
const RULED = 1;
const OTHER = 2;

/** Inserts a merchants row per [key, category] pair; a key with no pair has no row. */
const seed = (rows: [string, number][]) =>
	db.batch(
		rows.map(([rawName, category]) =>
			db
				.prepare(
					"INSERT INTO merchants (raw_name, default_category_id) VALUES (?, ?)",
				)
				.bind(rawName, category),
		),
	);

/** The key list of `size` keys with the given prefix, each numbered. */
const keysOf = (prefix: string, size: number) =>
	Array.from({ length: size }, (_, i) => `${prefix} ${i + 1}`);

describe("groupHasRule over a matrix of key lists", () => {
	it("answers each key list the way the one-query-per-chunk version did", async () => {
		const answers: { label: string; answer: boolean }[] = [];

		const ask = async (label: string, keys: string[], category = RULED) =>
			answers.push({
				label,
				answer: await groupHasRule(db, keys, category),
			});

		await ask("no keys", []);

		await seed([["M1 ruled", RULED]]);
		await ask("one key, ruled", ["M1 ruled"]);

		await seed([["M2 other", OTHER]]);
		await ask("one key, ruled with another category", ["M2 other"]);

		await ask("one key with no merchants row", ["M3 none"]);

		await seed([["M4 a", RULED]]);
		await ask("some ruled, some not", ["M4 a", "M4 b"]);

		await ask("duplicates of a ruled key", ["M1 ruled", "M1 ruled"]);
		await ask("duplicates, one key not ruled", ["M4 a", "M4 a", "M4 b"]);

		const odd = ['O\'REILLY %50 "Q"', "CAFÉ 日本", "a_b\\c"];
		await seed(odd.map((key) => [key, RULED]));
		await ask("keys with quotes, percent, underscore and unicode", odd);
		await ask("a percent key with no row", ["PCT%"]);

		for (const size of [90, 91, 180, 181]) {
			const prefix = `BIG ${size}`;
			const keys = keysOf(prefix, size);
			await seed(keys.map((key) => [key, RULED]));
			await ask(`${size} keys, all ruled`, keys);
			await ask(`${size} keys, all ruled and each twice`, [...keys, ...keys]);
			await ask(`${size} keys, all ruled, one more with no row`, [
				...keys,
				`${prefix} missing`,
			]);
			await seed([[`${prefix} other`, OTHER]]);
			await ask(`${size} keys, all ruled, the last with another category`, [
				...keys.slice(0, -1),
				`${prefix} other`,
			]);
		}

		expect(answers).toEqual(RECORDED);
	});
});

// The answers recorded on the code before the change, in the order the matrix asks them.
const RECORDED: { label: string; answer: boolean }[] = [
	{ label: "no keys", answer: true },
	{ label: "one key, ruled", answer: true },
	{ label: "one key, ruled with another category", answer: false },
	{ label: "one key with no merchants row", answer: false },
	{ label: "some ruled, some not", answer: false },
	{ label: "duplicates of a ruled key", answer: true },
	{ label: "duplicates, one key not ruled", answer: false },
	{ label: "keys with quotes, percent, underscore and unicode", answer: true },
	{ label: "a percent key with no row", answer: false },
	{ label: "90 keys, all ruled", answer: true },
	{ label: "90 keys, all ruled and each twice", answer: true },
	{ label: "90 keys, all ruled, one more with no row", answer: false },
	{
		label: "90 keys, all ruled, the last with another category",
		answer: false,
	},
	{ label: "91 keys, all ruled", answer: true },
	{ label: "91 keys, all ruled and each twice", answer: true },
	{ label: "91 keys, all ruled, one more with no row", answer: false },
	{
		label: "91 keys, all ruled, the last with another category",
		answer: false,
	},
	{ label: "180 keys, all ruled", answer: true },
	{ label: "180 keys, all ruled and each twice", answer: true },
	{ label: "180 keys, all ruled, one more with no row", answer: false },
	{
		label: "180 keys, all ruled, the last with another category",
		answer: false,
	},
	{ label: "181 keys, all ruled", answer: true },
	{ label: "181 keys, all ruled and each twice", answer: true },
	{ label: "181 keys, all ruled, one more with no row", answer: false },
	{
		label: "181 keys, all ruled, the last with another category",
		answer: false,
	},
];

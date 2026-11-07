// Spike, candidate 1: a tagged template that owns its parameters, so SQL pieces compose without counting `?`s.
import { SCHEMA } from "./schema.generated.ts";

type TableName = keyof typeof SCHEMA;
export type Fragment = { readonly text: string[]; readonly values: unknown[] };

const isFragment = (v: unknown): v is Fragment => typeof v === "object" && v !== null && "text" in v && "values" in v;

/** A table name checked against the real schema, the only way an identifier gets into SQL. */
export const table = (name: TableName): Fragment => {
	if (!(name in SCHEMA)) throw new Error(`no table ${String(name)}`);
	return { text: [name], values: [] };
};

/** Fragments nest; plain values become parameters, numbered when the statement is finally built. */
export function q(strings: TemplateStringsArray, ...parts: unknown[]): Fragment {
	const text: string[] = [strings[0] ?? ""];
	const values: unknown[] = [];
	parts.forEach((part, i) => {
		if (isFragment(part)) {
			// splice: the fragment's text joins the current text, its values follow ours
			text[text.length - 1] += part.text[0] ?? "";
			for (let j = 0; j < part.values.length; j++) {
				values.push(part.values[j]);
				text.push(part.text[j + 1] ?? "");
			}
			text[text.length - 1] += strings[i + 1] ?? "";
		} else {
			values.push(part);
			text.push(strings[i + 1] ?? "");
		}
	});
	return { text, values };
}

export function prepare(db: D1Database, fragment: Fragment): D1PreparedStatement {
	const sql = fragment.text.reduce((acc, piece, i) => acc + (i === 0 ? "" : `?${i}`) + piece, "");
	return db.prepare(sql).bind(...fragment.values);
}

// Spike, candidate 1 (no new library): read the real schema from SQLite itself.
// Works on any "run a query, get rows" function: D1 in tests, node:sqlite in the generator script.
export type Rows = (sql: string) => Promise<Record<string, unknown>[]>;

export type TableInfo = {
	columns: { name: string; type: string; notNull: boolean; pk: boolean }[];
	/** Values of every `col IN ('a','b')` CHECK, by column. */
	checks: Record<string, string[]>;
	indexes: { name: string; unique: boolean; partial: boolean }[];
	/** Tables this one points at with a foreign key. */
	references: string[];
};
export type Schema = Record<string, TableInfo>;

const quote = (name: string) => `'${name.replaceAll("'", "''")}'`;

export async function introspect(rows: Rows): Promise<Schema> {
	const tables = await rows(
		"SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name",
	);
	const schema: Schema = {};
	for (const { name, sql } of tables as { name: string; sql: string }[]) {
		const columns = (await rows(`PRAGMA table_info(${quote(name)})`)).map((c) => ({
			name: String(c.name),
			type: String(c.type),
			notNull: Boolean(c.notnull),
			pk: Number(c.pk) > 0,
		}));
		const checks: Record<string, string[]> = {};
		for (const { name: column } of columns) {
			const m = sql.match(new RegExp(`\\b${column}\\s+IN\\s*\\(([^)]*)\\)`));
			if (m) checks[column] = [...(m[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1] ?? "");
		}
		const indexes = (
			(await rows(
				`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${quote(name)} AND sql IS NOT NULL ORDER BY name`,
			)) as { name: string; sql: string }[]
		).map((i) => ({ name: i.name, unique: /^CREATE UNIQUE/i.test(i.sql), partial: /\sWHERE\s/i.test(i.sql) }));
		const references = [
			...new Set((await rows(`PRAGMA foreign_key_list(${quote(name)})`)).map((f) => String(f.table))),
		].sort();
		schema[name] = { columns, checks, indexes, references };
	}
	return schema;
}

/** Everything `generated` claims that `live` does not back up, and the reverse. Empty means in step. */
export function diff(generated: Schema, live: Schema): string[] {
	const problems: string[] = [];
	for (const name of new Set([...Object.keys(generated), ...Object.keys(live)])) {
		const g = generated[name];
		const l = live[name];
		if (!g) problems.push(`table ${name} is in the database, not in the generated schema`);
		else if (!l) problems.push(`table ${name} is in the generated schema, not in the database`);
		else if (JSON.stringify(g) !== JSON.stringify(l)) {
			const gc = g.columns.map((c) => c.name);
			const lc = l.columns.map((c) => c.name);
			for (const c of lc.filter((c) => !gc.includes(c))) problems.push(`${name}.${c} is in the database, not in the generated schema`);
			for (const c of gc.filter((c) => !lc.includes(c))) problems.push(`${name}.${c} is in the generated schema, not in the database`);
			if (JSON.stringify(g.checks) !== JSON.stringify(l.checks)) problems.push(`${name} CHECK lists differ`);
			if (JSON.stringify(g.indexes) !== JSON.stringify(l.indexes)) problems.push(`${name} indexes differ`);
			if (!problems.some((p) => p.startsWith(name))) problems.push(`${name} differs`);
		}
	}
	return problems;
}

/** Child tables first, so a DELETE of every table never breaks a foreign key. */
export function childFirst(schema: Schema): string[] {
	const order: string[] = [];
	const seen = new Set<string>();
	const visit = (name: string) => {
		if (seen.has(name)) return;
		seen.add(name);
		// a table that others point at must come after them, so visit its children first
		for (const [other, info] of Object.entries(schema))
			if (other !== name && info.references.includes(name)) visit(other);
		order.push(name);
	};
	for (const name of Object.keys(schema).sort()) visit(name);
	return order;
}

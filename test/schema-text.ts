// Pure readers of a CREATE TABLE statement for the drift test (test/db-schema.test.ts): its CHECK clauses, its
// AUTOINCREMENT keys and its COLLATE names, and the comparisons of each with the records in src/db/schema.ts. The
// test file cannot export (Biome), and the planted-bug tests call these with synthetic SQL, so they live here.
// Nothing in this file reads a database; the drift test passes it the sqlite_master text it reads.
//
// Every reader works on a masked copy of the statement: the inside of each 'literal' and "identifier" is replaced by
// `_` (same length, quotes kept), so a parenthesis, a comma or the word CHECK inside a literal is never read as SQL.
// The text that is returned is cut from the original statement, so literals come back byte-exact.

/** One CHECK clause as the database has it: its owning column (undefined for a table-level CHECK) and its raw text. */
export interface LiveCheck {
	column: string | undefined;
	expression: string;
}

/** The non-IN CHECKs a table is expected to have: one expression per column, and a list for table-level ones. */
export interface CheckRecord {
	columns: Readonly<Record<string, string>>;
	tables: readonly string[];
}

interface Item {
	/** The column the definition is for, or undefined for a table-level item (a CHECK, UNIQUE, CONSTRAINT...). */
	column: string | undefined;
	text: string;
	masked: string;
}

interface NonInCheck {
	column: string | undefined;
	/** The expression as the migration wrote it, spacing and identifier quotes tidied, keyword case kept. */
	display: string;
	/** The comparison form: lower case outside literals, spacing and quotes dropped, redundant parentheses dropped. */
	key: string;
}

interface Segment {
	literal: boolean;
	text: string;
}

const TABLE_LEVEL_ITEM = /^\s*(CONSTRAINT|CHECK|PRIMARY|UNIQUE|FOREIGN)\b/i;
const IN_LIST = /^\w+\s+IN\s*\([^()]*\)$/i;

/** The closing character of a quoted span that opens with `open`: a bracketed name closes with `]`. */
function closerOf(open: string): string {
	return open === "[" ? "]" : open;
}

/**
 * The statement with its SQL comments (`-- ...` to the end of the line, and `/* ... *\/`) replaced by a space. SQLite
 * keeps comments in sqlite_master.sql, so they are removed before anything reads the statement. A `--` or `/*` inside
 * a literal or a quoted name is not a comment and is left as it is.
 */
export function stripComments(sql: string): string {
	let out = "";
	let closer = "";

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i] ?? "";
		const next = sql[i + 1];

		if (closer !== "") {
			out += ch;

			if (ch === closer) {
				if (closer !== "]" && next === closer) {
					out += next;
					i++;
				} else closer = "";
			}
		} else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
			closer = closerOf(ch);
			out += ch;
		} else if (ch === "-" && next === "-") {
			const end = sql.indexOf("\n", i);

			out += " ";
			i = end < 0 ? sql.length : end - 1;
		} else if (ch === "/" && next === "*") {
			const end = sql.indexOf("*/", i + 2);

			if (end < 0) throw new Error(`an unclosed comment in: ${sql}`);
			out += " ";
			i = end + 1;
		} else out += ch;
	}

	return out;
}

/**
 * Same length as the input; the inside of each 'literal', "identifier", `identifier` and [identifier] is `_`, and the
 * quotes stay. A comment must be stripped first (stripComments), or its words are read as SQL.
 */
export function maskLiterals(sql: string): string {
	let out = "";
	let closer = "";

	for (let i = 0; i < sql.length; i++) {
		const ch = sql[i] ?? "";

		if (closer === "") {
			if (ch === "'" || ch === '"' || ch === "`" || ch === "[")
				closer = closerOf(ch);
			out += ch;
		} else if (ch === closer) {
			if (closer !== "]" && sql[i + 1] === closer) {
				out += "__";
				i++;
			} else {
				closer = "";
				out += ch;
			}
		} else out += "_";
	}

	if (closer !== "")
		throw new Error("an unclosed quote in a CREATE TABLE text");

	return out;
}

/** The index of the parenthesis that closes the one at `open`, read on masked text. */
function closeIndex(masked: string, open: number): number {
	let depth = 0;

	for (let i = open; i < masked.length; i++) {
		const ch = masked[i];

		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;

			if (depth === 0) return i;
		}
	}

	throw new Error("unbalanced parentheses in a CREATE TABLE text");
}

/** The statement's top-level definitions: the text between the table's parentheses, cut at each comma outside any. */
function items(sqlWithComments: string): Item[] {
	const createSql = stripComments(sqlWithComments);
	const masked = maskLiterals(createSql);
	const open = masked.indexOf("(");

	if (open < 0) return [];

	const close = closeIndex(masked, open);
	const starts = [open + 1];
	const ends: number[] = [];
	let depth = 0;

	for (let i = open + 1; i < close; i++) {
		const ch = masked[i];

		if (ch === "(") depth++;
		else if (ch === ")") depth--;
		else if (ch === "," && depth === 0) {
			ends.push(i);
			starts.push(i + 1);
		}
	}

	ends.push(close);

	const found: Item[] = [];

	for (const [i, start] of starts.entries()) {
		const end = ends[i] ?? close;
		const text = createSql.slice(start, end);
		const masks = masked.slice(start, end);

		if (text.trim() === "") continue;

		found.push({
			column: TABLE_LEVEL_ITEM.test(masks) ? undefined : firstName(text),
			text,
			masked: masks,
		});
	}

	return found;
}

/** A column definition's name, with its identifier quotes removed. */
function firstName(text: string): string {
	const token = /^\s*("[^"]*"|`[^`]*`|\[[^\]]*\]|\w+)/.exec(text)?.[1];

	if (token === undefined) throw new Error(`no column name in: ${text}`);

	return token.replace(/^["`[]|["`\]]$/g, "");
}

/** Every CHECK clause, column-level or table-level, with the text between its own parentheses. */
export function liveCheckClauses(createSql: string): LiveCheck[] {
	const found: LiveCheck[] = [];

	for (const item of items(createSql))
		for (const match of item.masked.matchAll(/\bCHECK\s*\(/gi)) {
			const open = match.index + match[0].length - 1;
			const close = closeIndex(item.masked, open);

			found.push({
				column: item.column,
				expression: item.text.slice(open + 1, close),
			});
		}

	return found;
}

/** The CHECKs that are not `col IN (...)` value lists: those belong to CHECK_LISTS and are read there. */
function nonInChecks(createSql: string): NonInCheck[] {
	return liveCheckClauses(createSql)
		.filter((check) => !IN_LIST.test(maskLiterals(check.expression).trim()))
		.map((check) => ({
			column: check.column,
			display: displayCheck(check.expression),
			key: normaliseCheck(check.expression),
		}));
}

/** The index of the quote that closes the literal opened at `open`; a doubled quote inside is part of the literal. */
function literalEnd(text: string, open: number): number {
	let at = open + 1;

	while (at < text.length) {
		if (text[at] !== "'") at++;
		else if (text[at + 1] === "'") at += 2;
		else return at;
	}

	throw new Error(`an unclosed literal in: ${text}`);
}

/** Splits an expression into its literals (kept byte-exact) and the text around them (identifier quotes removed). */
function segments(expression: string): Segment[] {
	const out: Segment[] = [];
	let outside = "";

	for (let i = 0; i < expression.length; i++) {
		const ch = expression[i] ?? "";

		if (ch === "'") {
			const end = literalEnd(expression, i);

			out.push({ literal: false, text: outside });
			out.push({ literal: true, text: expression.slice(i, end + 1) });
			outside = "";
			i = end;
		} else if (ch === '"' || ch === "`" || ch === "[") {
			const closer = ch === "[" ? "]" : ch;
			const end = expression.indexOf(closer, i + 1);

			if (end < 0) throw new Error(`an unclosed identifier in: ${expression}`);
			outside += expression.slice(i + 1, end);
			i = end;
		} else outside += ch;
	}

	out.push({ literal: false, text: outside });

	return out;
}

/** The text, trimmed, with each pair of parentheses that wraps all of it removed (repeatedly). */
function unwrap(text: string): string {
	let current = text.trim();

	while (
		current.startsWith("(") &&
		closeIndex(maskLiterals(current), 0) === current.length - 1
	)
		current = current.slice(1, -1).trim();

	return current;
}

/** The expression for the record: spelled as written (case kept), whitespace collapsed, redundant outer parentheses off. */
export function displayCheck(expression: string): string {
	const text = segments(expression)
		.map((part) => (part.literal ? part.text : part.text.replace(/\s+/g, " ")))
		.join("");

	return unwrap(text);
}

/**
 * The comparison form of an expression. Outside literals: lower case, one space at most, no space around the
 * punctuation ( ) , = < > ! | and none at the edge of a literal; literals stay byte-exact, so 'integer' and 'INTEGER'
 * differ and 'Q[1-4]' and 'q[1-4]' differ, while spacing, keyword case, identifier quoting and outer parentheses do not.
 */
export function normaliseCheck(expression: string): string {
	const text = segments(expression)
		.map((part) =>
			part.literal
				? part.text
				: part.text
						.toLowerCase()
						.replace(/\s+/g, " ")
						.replace(/ ?([(),=<>!|]) ?/g, "$1")
						.trim(),
		)
		.join("");

	return unwrap(text);
}

/** Compares a CREATE TABLE's non-IN CHECKs with the record for its table. Empty means in step. */
export function checkProblems(
	createSql: string,
	table: string,
	record: CheckRecord,
): string[] {
	const problems: string[] = [];
	const columnChecks = new Map<string, NonInCheck[]>();
	const tableChecks: NonInCheck[] = [];

	for (const check of nonInChecks(createSql)) {
		if (check.column === undefined) tableChecks.push(check);
		else
			columnChecks.set(check.column, [
				...(columnChecks.get(check.column) ?? []),
				check,
			]);
	}

	for (const [column, found] of columnChecks) {
		const where = `${table}.${column}`;
		const want: string | undefined = record.columns[column];
		const only = found[0];

		if (want === undefined)
			problems.push(
				`${where} has a CHECK in the database and no entry in CHECKS`,
			);
		else if (found.length > 1)
			problems.push(
				`${where} has ${found.length} CHECKs in the database, and CHECKS holds one per column`,
			);
		else if (only && only.key !== normaliseCheck(want))
			problems.push(
				`${where} CHECK differs: CHECKS ${want}, database ${only.display}`,
			);
	}

	for (const column of Object.keys(record.columns))
		if (!columnChecks.has(column))
			problems.push(
				`CHECKS has ${table}.${column}, but the database has no such CHECK`,
			);

	const wanted = [...record.tables];

	for (const check of tableChecks) {
		const at = wanted.findIndex((text) => normaliseCheck(text) === check.key);

		if (at < 0)
			problems.push(
				`${table} has a table-level CHECK (${check.display}) that TABLE_CHECKS does not list`,
			);
		else wanted.splice(at, 1);
	}

	for (const text of wanted)
		problems.push(
			`TABLE_CHECKS lists a ${table} CHECK (${text}), but the database has no such CHECK`,
		);

	return problems;
}

/** The record a CREATE TABLE's non-IN CHECKs make, for writing into CHECKS and TABLE_CHECKS. One CHECK per column. */
export function liveCheckRecord(createSql: string) {
	const columns: Record<string, string> = {};
	const tables: string[] = [];

	for (const check of nonInChecks(createSql)) {
		if (check.column === undefined) tables.push(check.display);
		else if (columns[check.column] !== undefined)
			throw new Error(`two non-IN CHECKs on ${check.column}`);
		else columns[check.column] = check.display;
	}

	return { columns, tables };
}

/** The columns whose definition has the AUTOINCREMENT keyword outside literals. */
export function liveAutoIncrementColumns(createSql: string): string[] {
	const found: string[] = [];

	for (const item of items(createSql))
		if (item.column !== undefined && /\bAUTOINCREMENT\b/i.test(item.masked))
			found.push(item.column);

	return found;
}

/** Compares the AUTOINCREMENT keys of a CREATE TABLE with the columns the schema says are autoIncrement. */
export function autoIncrementProblems(
	createSql: string,
	table: string,
	schemaColumns: readonly string[],
): string[] {
	const live = liveAutoIncrementColumns(createSql);
	const problems: string[] = [];

	for (const column of live)
		if (!schemaColumns.includes(column))
			problems.push(
				`${table}.${column} is AUTOINCREMENT in the database, but the schema does not say so`,
			);

	for (const column of schemaColumns)
		if (!live.includes(column))
			problems.push(
				`${table}.${column} is AUTOINCREMENT in the schema, but the database has no AUTOINCREMENT`,
			);

	return problems;
}

/**
 * The collation name after a COLLATE keyword, read from the original text at `at`: a bare word, or a double-quoted,
 * bracketed or backtick-quoted name. Upper-cased, because SQLite collation names are case-insensitive (NOCASE and
 * nocase are the same collation). Anything else throws, so a COLLATE this reader cannot read fails the test.
 */
function collationName(text: string, at: number): string {
	const rest = text.slice(at);

	const found =
		/^\s*(?:(\w+)|"((?:[^"]|"")*)"|\[([^\]]*)\]|`((?:[^`]|``)*)`)/.exec(rest);

	if (!found)
		throw new Error(
			`cannot read the COLLATE name after COLLATE in: ${text.trim()}`,
		);

	const name = found[1] ?? found[2] ?? found[3] ?? found[4] ?? "";

	return name.replace(/""/g, '"').replace(/``/g, "`").toUpperCase();
}

/** Every COLLATE in a CREATE TABLE: its column, and its collation in upper case. A table-level one is named by its item. */
export function liveCollations(
	sqlWithComments: string,
): { column: string; collation: string }[] {
	const found: { column: string; collation: string }[] = [];

	for (const item of items(sqlWithComments))
		for (const match of item.masked.matchAll(/\bCOLLATE\b/gi))
			found.push({
				column: item.column ?? "(table constraint)",
				collation: collationName(item.text, match.index + match[0].length),
			});

	return found;
}

/** Compares a CREATE TABLE's COLLATE names with the record for its table, keyed by column. */
export function collationProblems(
	createSql: string,
	table: string,
	expected: Readonly<Record<string, string>>,
): string[] {
	const live = liveCollations(createSql);
	const problems: string[] = [];

	for (const { column, collation } of live) {
		const want: string | undefined = expected[column];

		if (want === undefined)
			problems.push(
				`${table}.${column} has COLLATE ${collation} in the database, but COLLATIONS does not list it`,
			);
		else if (want.toUpperCase() !== collation)
			problems.push(
				`${table}.${column} COLLATE differs: COLLATIONS ${want}, database ${collation}`,
			);
	}

	for (const [column, want] of Object.entries(expected))
		if (!live.some((entry) => entry.column === column))
			problems.push(
				`COLLATIONS lists ${table}.${column} COLLATE ${want}, but the database has no COLLATE on it`,
			);

	return problems;
}

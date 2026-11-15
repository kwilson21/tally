// Inputs for the Apple Card CSV reader (#1120): real-looking files in each header variant, every refusal in each position
// and order, and the edge values of each field. Pure: the characterise test runs each one through parseAppleCsv and
// compares the answer with fixtures/apple-card-csv-baseline.json, which was recorded on the code before the schema change.
// Every name and merchant here is made up for the Rivera family.

export type CsvCase = { label: string; text: string };

const H7 =
	"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)";

const H8 = `${H7},Purchased By`;

const GOOD =
	'10/03/2026,10/04/2026,"GREENLEAF MARKET #12","Greenleaf Market","Grocery","Purchase","38.40"';

/** Joins lines the way Apple's file ends them: LF, with a final newline. */
const file = (...lines: string[]) => `${lines.join("\n")}\n`;

/** A file with the 7-column header and the given rows. */
const rows7 = (...rows: string[]) => file(H7, ...rows);

/** Fills the seven cells of a row, each one replaced by the given value at its index. */
function cells(over: Record<number, string>): string {
	const base = [
		"10/03/2026",
		"10/04/2026",
		"GREENLEAF MARKET",
		"Greenleaf Market",
		"Grocery",
		"Purchase",
		"38.40",
	];

	return base.map((value, i) => over[i] ?? value).join(",");
}

/** A description of the given number of UTF-16 units, made of one character. */
const units = (char: string, count: number) => char.repeat(count);

export const cases = (): CsvCase[] => [
	// Header variants and line endings
	{ label: "header 7 LF", text: file(H7, GOOD) },
	{ label: "header 8 LF", text: file(H8, `${GOOD},Pat Rivera`) },
	{ label: "header 7 CRLF", text: `${H7}\r\n${GOOD}\r\n` },
	{ label: "header 8 CRLF", text: `${H8}\r\n${GOOD},Pat Rivera\r\n` },
	{ label: "header CR only", text: `${H7}\r${GOOD}\r` },
	{
		label: "mixed line endings",
		text: `${H7}\r\n${GOOD}\n${GOOD}\r${GOOD}\r\n`,
	},
	{ label: "no final newline", text: `${H7}\n${GOOD}` },
	{ label: "BOM before header", text: `﻿${file(H7, GOOD)}` },
	{
		label: "BOM then header with spaces",
		text: `﻿${file(` ${H7.replace(/,/g, " , ")} `, GOOD)}`,
	},
	{
		label: "header cells quoted",
		text: file(`"${H7.split(",").join('","')}"`, GOOD),
	},
	{
		label: "header cell with trailing space inside quotes",
		text: file(H7.replace("Amount (USD)", '"Amount (USD) "'), GOOD),
	},
	{ label: "header only", text: file(H7) },
	{ label: "header then blank lines", text: `${H7}\n\n\n` },
	{ label: "header with extra blank record between", text: file(H7, "", GOOD) },
	{ label: "empty text", text: "" },
	{ label: "BOM only", text: "﻿" },
	{
		label: "header wrong order",
		text: file(
			H7.replace(
				"Clearing Date,Transaction Date",
				"Transaction Date,Clearing Date",
			),
			GOOD,
		),
	},
	{
		label: "header missing a column",
		text: file(H7.replace(",Type", ""), GOOD),
	},
	{ label: "header 9 columns", text: file(`${H8},Extra`, GOOD) },
	{
		label: "header Purchased By lower case",
		text: file(`${H7},Purchased by`, GOOD),
	},
	{ label: "header with a quote open", text: `"${H7}\n${GOOD}\n` },
	{
		label: "header malformed quote",
		text: file(`"Transaction Date"x,${H7.split(",").slice(1).join(",")}`, GOOD),
	},
	{
		label: "header with full-width letters",
		text: file(H7.replace("Type", "Ｔype"), GOOD),
	},
	{
		label: "header with replacement char",
		text: file(H7.replace("Type", "T�ype"), GOOD),
	},

	// Good files
	{
		label: "several rows keep their order and line numbers",
		text: rows7(
			GOOD,
			'10/05/2026,,"TRANSIT PASS","Metro","Transportation","Purchase","2.75"',
			'10/06/2026,10/07/2026,"PAYMENT","","","Payment","-120.00"',
		),
	},
	{
		label: "8-column rows with Purchased By",
		text: file(H8, `${GOOD},Pat Rivera`, `${GOOD},"Rivera, Sam"`, `${GOOD},`),
	},
	{
		label: "quoted cells with commas and line breaks",
		text: rows7(
			`10/03/2026,,"LINE ONE\nLINE TWO, INC",Merchant,Cat,Purchase,5.00`,
		),
	},
	{
		label: "quoted cell with CRLF inside",
		text: rows7(`10/03/2026,,"A\r\nB",M,C,Purchase,5.00`),
	},
	{
		label: "doubled quotes",
		text: rows7(`10/03/2026,,"5"" PIZZA ""BIG""",M,C,Purchase,5.00`),
	},
	{
		label: "empty quoted cells",
		text: rows7(`10/03/2026,"",D,"","",Purchase,5.00`),
	},
	{
		label: "whitespace-only merchant and category",
		text: rows7(`10/03/2026,,D,"  ","   ",Purchase,5.00`),
	},
	{
		label: "clearing date only spaces",
		text: rows7(`10/03/2026," ",D,M,C,Purchase,5.00`),
	},
	{ label: "trailing blank line", text: rows7(GOOD, "") },
	{ label: "trailing blank lines CRLF", text: `${H7}\r\n${GOOD}\r\n\r\n\r\n` },
	{ label: "all-empty record skipped", text: rows7(GOOD, ",,,,,,", GOOD) },
	{
		label: "all-empty record with spaces skipped",
		text: rows7(GOOD, "  , ,  ,,,, ", GOOD),
	},
	{ label: "empty record in the middle skipped", text: rows7(GOOD, "", GOOD) },
	{
		label: "empty record then bad amount keeps line 4",
		text: rows7(GOOD, ",,,,,,", GOOD, cells({ 6: "x" })),
	},
	{
		label: "record after a multi-line cell counts records",
		text: rows7(`10/03/2026,,"a\nb\nc",M,C,Purchase,5.00`, cells({ 6: "x" })),
	},
	{
		label: "unicode merchant and description",
		text: rows7(`10/03/2026,,"Ñandú 北京 bakery",Ñandú,Café,Purchase,5.00`),
	},
	{
		label: "NFD description becomes NFC",
		text: rows7(`10/03/2026,,"Café CAFÉ",Café,Café,Purchase,5.00`),
	},
	{
		label: "NFC description unchanged",
		text: rows7(`10/03/2026,,"Café",Café,Café,Purchase,5.00`),
	},

	// Malformed quotes
	{
		label: "quote in the middle of a cell",
		text: rows7(`10/03/2026,,Groc"ery,M,C,Purchase,5.00`),
	},
	{
		label: "text after a closed quote",
		text: rows7(`10/03/2026,,"Grocery"x,M,C,Purchase,5.00`),
	},
	{
		label: "malformed record of blank-looking cells",
		text: rows7(GOOD, `"" ,,,,,,`),
	},
	{
		label: "malformed record after a good row",
		text: rows7(GOOD, `10/03/2026,,"A"B,M,C,Purchase,5.00`),
	},
	{
		label: "malformed record wins over a later bad amount",
		text: rows7(`10/03/2026,,"A"B,M,C,Purchase,5.00`, cells({ 6: "x" })),
	},
	{
		label: "open quote at the end of a row",
		text: rows7(GOOD, `10/03/2026,,"never closed,M,C,Purchase,5.00\n`),
	},
	{
		label: "open quote with more lines inside",
		text: rows7(GOOD, `10/03/2026,,"a\nb\n10/04/2026,,x,y,z,Purchase,5.00\n`),
	},
	{
		label: "open quote after a bad amount wins for the amount",
		text: rows7(cells({ 6: "x" }), `10/03/2026,,"open`),
	},
	{ label: "open quote in the header", text: `"${H7}\n${GOOD}\n` },

	// Row shape
	{
		label: "6 fields in a 7-column file",
		text: rows7("10/03/2026,10/04/2026,D,M,C,Purchase"),
	},
	{ label: "8 fields in a 7-column file", text: rows7(`${GOOD},Pat`) },
	{ label: "7 fields in an 8-column file", text: file(H8, GOOD) },
	{
		label: "7 fields with 8 columns, bad amount too",
		text: file(H8, cells({ 6: "x" })),
	},
	{
		label: "field count and bad amount: count first",
		text: rows7(`10/03/2026,${cells({ 6: "x" })}`),
	},
	{
		label: "replacement char in description and bad amount",
		text: rows7(cells({ 2: "A�B", 6: "x" })),
	},
	{ label: "replacement char in merchant", text: rows7(cells({ 3: "M�" })) },
	{
		label: "replacement char in date",
		text: rows7(cells({ 0: "10/03/202�" })),
	},
	{
		label: "replacement char in a blank cell",
		text: rows7(cells({ 3: "�", 4: "", 5: "" })),
	},

	// Refusals in order: amount, then transaction date, then clearing date, then description and type
	{
		label: "bad amount and bad date: amount first",
		text: rows7(cells({ 0: "13/1/2024", 6: "x" })),
	},
	{
		label: "bad transaction date and bad clearing date: transaction first",
		text: rows7(cells({ 0: "2/30/2024", 1: "bad" })),
	},
	{
		label: "bad clearing date with good transaction date",
		text: rows7(cells({ 1: "2/30/2026" })),
	},
	{
		label: "bad transaction date with good clearing date",
		text: rows7(cells({ 0: "2/30/2026" })),
	},
	{
		label: "blank description with bad date: date sentence",
		text: rows7(cells({ 0: "2/30/2026", 2: "" })),
	},
	{ label: "blank description with good date", text: rows7(cells({ 2: "" })) },
	{ label: "description of spaces", text: rows7(cells({ 2: "   " })) },
	{ label: "blank type", text: rows7(cells({ 5: "" })) },
	{
		label: "blank amount with bad date: amount first",
		text: rows7(cells({ 0: "x", 6: "" })),
	},
	{
		label: "bad amount in the first of two bad rows",
		text: rows7(cells({ 6: "x" }), cells({ 0: "x" })),
	},
	{
		label: "bad date in the first of two bad rows",
		text: rows7(GOOD, cells({ 0: "x" }), cells({ 6: "x" })),
	},
	{
		label: "bad row after a blank record",
		text: rows7(GOOD, "", cells({ 0: "x" })),
	},
	{
		label: "good row after a bad one is never read",
		text: rows7(cells({ 6: "x" }), GOOD),
	},

	// Dates
	{ label: "date 2/30/2024", text: rows7(cells({ 0: "2/30/2024" })) },
	{ label: "date 02/29/2023", text: rows7(cells({ 0: "02/29/2023" })) },
	{ label: "date 2/29/2024", text: rows7(cells({ 0: "2/29/2024" })) },
	{ label: "date 13/1/2024", text: rows7(cells({ 0: "13/1/2024" })) },
	{ label: "date 0/1/2024", text: rows7(cells({ 0: "0/1/2024" })) },
	{ label: "date 1/1/24", text: rows7(cells({ 0: "1/1/24" })) },
	{
		label: "date 1/1/2024 with a trailing space",
		text: rows7(cells({ 0: "1/1/2024 " })),
	},
	{
		label: "date with a leading space",
		text: rows7(cells({ 0: " 1/1/2024" })),
	},
	{ label: "date with a tab", text: rows7(cells({ 0: "1/1/2024\t" })) },
	{ label: "date 2/29/0000", text: rows7(cells({ 0: "2/29/0000" })) },
	{ label: "date 1/1/0001", text: rows7(cells({ 0: "1/1/0001" })) },
	{ label: "date 12/31/9999", text: rows7(cells({ 0: "12/31/9999" })) },
	{ label: "date 00/10/2024", text: rows7(cells({ 0: "00/10/2024" })) },
	{ label: "date 1/00/2024", text: rows7(cells({ 0: "1/00/2024" })) },
	{ label: "date with 5 digit year", text: rows7(cells({ 0: "1/1/20245" })) },
	{ label: "date ISO form", text: rows7(cells({ 0: "2026-10-03" })) },
	{
		label: "date full-width digits",
		text: rows7(cells({ 0: "１０/０３/２０２６" })),
	},
	{ label: "date Arabic-Indic digits", text: rows7(cells({ 0: "١/١/٢٠٢٤" })) },
	{ label: "clearing date blank is null", text: rows7(cells({ 1: "" })) },
	{
		label: "clearing date 10/04/2026",
		text: rows7(cells({ 1: "10/04/2026" })),
	},
	{ label: "clearing date 2/30/2026", text: rows7(cells({ 1: "2/30/2026" })) },
	{
		label: "clearing date with a leading zero month and space",
		text: rows7(cells({ 1: " 01/5/2026 " })),
	},

	// Amounts
	{ label: "amount $5", text: rows7(cells({ 6: "$5" })) },
	{ label: "amount $5.00", text: rows7(cells({ 6: "$5.00" })) },
	{ label: "amount 1,234.50", text: rows7(cells({ 6: "1,234.50" })) },
	{ label: "amount -12.30", text: rows7(cells({ 6: "-12.30" })) },
	{ label: "amount 12,34", text: rows7(cells({ 6: "12,34" })) },
	{ label: "amount 1e3", text: rows7(cells({ 6: "1e3" })) },
	{ label: "amount 0", text: rows7(cells({ 6: "0" })) },
	{ label: "amount -0.00", text: rows7(cells({ 6: "-0.00" })) },
	{
		label: "amount 9007199254740993",
		text: rows7(cells({ 6: "9007199254740993" })),
	},
	{ label: "amount 16 digits", text: rows7(cells({ 6: "1234567890123456" })) },
	{ label: "amount .5", text: rows7(cells({ 6: ".5" })) },
	{ label: "amount 5.", text: rows7(cells({ 6: "5." })) },
	{ label: "amount spaces around 5", text: rows7(cells({ 6: "  5 " })) },
	{ label: "amount empty", text: rows7(cells({ 6: "" })) },
	{ label: "amount a dash", text: rows7(cells({ 6: "-" })) },
	{ label: "amount plus sign", text: rows7(cells({ 6: "+5" })) },
	{ label: "amount three decimals", text: rows7(cells({ 6: "5.001" })) },
	{ label: "amount one decimal", text: rows7(cells({ 6: "12.3" })) },
	{ label: "amount 1,2,3.00", text: rows7(cells({ 6: "1,2,3.00" })) },
	{ label: "amount full-width digits", text: rows7(cells({ 6: "３８.４０" })) },
	{ label: "amount 12.345", text: rows7(cells({ 6: "12.345" })) },
	{
		label: "amount 1,234,567,890,123.45",
		text: rows7(cells({ 6: "1,234,567,890,123.45" })),
	},
	{
		label: "amount 99999999999999.99",
		text: rows7(cells({ 6: "99999999999999.99" })),
	},

	// Length cap (cleaned text, UTF-16 units)
	{
		label: "description 1000 characters",
		text: rows7(cells({ 2: units("a", 1000) })),
	},
	{
		label: "description 1001 characters",
		text: rows7(cells({ 2: units("a", 1001) })),
	},
	{
		label: "description 1002 raw, 1000 cleaned",
		text: rows7(cells({ 2: `  ${units("a", 1000)}  ` })),
	},
	{
		label: "description 2000 raw NFD, 1000 cleaned",
		text: rows7(cells({ 2: units("é", 1000) })),
	},
	{
		label: "description 500 emoji (1000 units)",
		text: rows7(cells({ 2: units("😀", 500) })),
	},
	{
		label: "description 501 emoji (1002 units)",
		text: rows7(cells({ 2: units("😀", 501) })),
	},
	{
		label: "merchant 1001 characters",
		text: rows7(cells({ 3: units("m", 1001) })),
	},
	{
		label: "category 1001 characters",
		text: rows7(cells({ 4: units("c", 1001) })),
	},
	{
		label: "type 1001 characters",
		text: rows7(cells({ 5: units("t", 1001) })),
	},
	{
		label: "amount 1001 characters",
		text: rows7(cells({ 6: `1${"0".repeat(1000)}` })),
	},
	{
		label: "clearing 1001 characters",
		text: rows7(cells({ 1: units("1", 1001) })),
	},
	{
		label: "1001 characters in a 8-column row's Purchased By",
		text: file(H8, `${cells({})},${units("p", 1001)}`),
	},

	// Blank merchant and category
	{
		label: "blank merchant and category are null",
		text: rows7(cells({ 3: "", 4: "" })),
	},
	{ label: "blank merchant only", text: rows7(cells({ 3: "" })) },
	{ label: "blank category only", text: rows7(cells({ 4: "" })) },
	{ label: "spaces-only merchant with a tab", text: rows7(cells({ 3: "\t" })) },
];

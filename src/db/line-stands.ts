// A leaf with no imports, so the queue and the reads can use it without a cycle through db/transactions (lookup/line.ts
// imports it back through the re-export there).

/** The line of the lookup text `text` (an SQL expression) stands: found, with a line, and no key of the text private (spec §7). */
// stays raw: a fragment inlined into raw statements (decision 179)
export const lineStandsSql = (text: string) =>
	`(EXISTS (SELECT 1 FROM merchant_lookups lsl WHERE lsl.lookup_text = ${text} AND lsl.status = 'found' AND COALESCE(lsl.line, '') != '')
		AND NOT EXISTS (SELECT 1 FROM merchant_lookup_texts lsp WHERE lsp.lookup_text = ${text} AND lsp.private = 1))`;

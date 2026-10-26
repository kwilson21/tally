// Fingerprints a page's load, so CI can tell which pages differ between `main` and the PR (decisions 152
// and 153). Pure: the page's HTML, its assets' hashes and the CSS rules it uses come in as plain values, so
// test/fingerprint.test.ts needs no browser and no server. scripts/screenshots.mjs does the loading, the
// hashing and the reading of the CSS.

/**
 * A random v4 UUID, as crypto.randomUUID() makes one. Every load of a page draws new ones, so they
 * are taken out before two loads are compared.
 */
const V4_UUID =
	/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const PLACEHOLDER = "<uuid>";

/** Code-unit order, so sorting never depends on the locale. */
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// A start tag as a browser serializes it (every attribute is name="value"), or a whole <script> or
// <style>, which is matched so that its raw text is left as it is.
const TAG =
	/<(script|style)\b[\s\S]*?<\/\1\s*>|<([a-zA-Z][\w:-]*)((?: [^\s"'<>/=]+="[^"]*")*)>/gi;
const ATTRIBUTE = / ([^\s"'<>/=]+)="([^"]*)"/g;

/**
 * A start tag with its attributes sorted by name. htmx and sheet.js set a page's attributes in
 * whichever order their scripts run (the transaction sheet's inert and htmx's powered mark, found
 * on /transactions/110 in #785), so two loads of one page can list them differently.
 * @param {string} tag
 * @param {string | undefined} raw The element name when the match is a <script> or <style>.
 * @param {string | undefined} name
 * @param {string | undefined} attributes
 * @returns {string}
 */
function sortTag(tag, raw, name, attributes) {
	if (raw !== undefined) return tag;
	const pairs = [...(attributes ?? "").matchAll(ATTRIBUTE)].map((m) => [
		m[1],
		m[2],
	]);
	pairs.sort(([a], [b]) => compare(a, b));
	return `<${name}${pairs.map(([key, value]) => ` ${key}="${value}"`).join("")}>`;
}

/**
 * The page's HTML with each per-request value replaced and each tag's attributes in one order, so
 * two loads of the same page on the same data give the same string. Per-request values: the Add
 * cash entry key (src/routes/transactions.tsx:1772) and the split sheet's sheet id and refund ids
 * (src/views/split-form.tsx:267), all random v4 UUIDs.
 * @param {string} html
 * @returns {string}
 */
export function normalizeDom(html) {
	return html
		.replace(TAG, (tag, raw, name, attributes) =>
			sortTag(tag, raw, name, attributes),
		)
		.replace(V4_UUID, PLACEHOLDER);
}

/**
 * SHA-256 of some bytes or text, as lowercase hex. Web Crypto, so the same code runs in vitest's
 * Workers pool and in Node.
 * @param {Uint8Array | string} data
 * @returns {Promise<string>}
 */
export async function sha256Hex(data) {
	const bytes =
		typeof data === "string" ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** The fields a load is fingerprinted and compared by, in the order changedParts names them. */
const PARTS = ["dom", "assets", "css"];

/**
 * A load as it is compared: its DOM normalized, its assets reduced to `path` and `sha256` and sorted
 * (so the order they loaded in doesn't matter; each reduced asset's keys always stringify the same way),
 * and its CSS as it is (the order of CSS matters). fingerprintOf and changedParts both use it, so they
 * can't disagree.
 * @param {{ dom: string, assets: { path: string, sha256: string }[], css: string[] }} load
 * @returns {{ dom: string, assets: { path: string, sha256: string }[], css: string[] }}
 */
function normalizeLoad({ dom, assets, css }) {
	const sorted = assets
		.map(({ path, sha256 }) => ({ path, sha256 }))
		.sort((a, b) => compare(a.path, b.path) || compare(a.sha256, b.sha256));
	return { dom: normalizeDom(dom), assets: sorted, css };
}

/**
 * A page's fingerprint: the SHA-256 of its normalized DOM, its same-origin assets (each one's path and
 * hash) and the CSS rules it uses, in document order (see normalizeLoad).
 * @param {{ dom: string, assets: { path: string, sha256: string }[], css: string[] }} load
 * @returns {Promise<string>}
 */
export async function fingerprintOf(load) {
	return sha256Hex(JSON.stringify(normalizeLoad(load)));
}

/**
 * Which parts of two loads differ, compared as fingerprintOf compares them, so a fingerprint change
 * can be explained by the job log: the DOM, the assets or the CSS.
 * @param {{ dom: string, assets: { path: string, sha256: string }[], css: string[] }} head
 * @param {{ dom: string, assets: { path: string, sha256: string }[], css: string[] }} base
 * @returns {("dom" | "assets" | "css")[]}
 */
export function changedParts(head, base) {
	const a = normalizeLoad(head);
	const b = normalizeLoad(base);
	return PARTS.filter(
		(part) => JSON.stringify(a[part]) !== JSON.stringify(b[part]),
	);
}

/**
 * Whether CI captures a page: when `main` can't show it (not ok, so the PR's is a new page), or when
 * the two fingerprints differ.
 * @param {{ head: { ok: boolean, fingerprint?: string }, base: { ok: boolean, fingerprint?: string } }} pages
 * @returns {boolean}
 */
export function needsCapture({ head, base }) {
	return !base.ok || base.fingerprint !== head.fingerprint;
}

/**
 * The selector with what a still page can't test taken out, ready for document.querySelector:
 * pseudo-elements, the legacy :before, :after, :first-line and :first-letter, and the user-action
 * pseudo-classes :hover, :focus, :focus-visible, :focus-within, :active and :visited. A compound left
 * empty becomes `*`, in each top-level part of a selector list. Escapes, brackets and quotes are
 * respected, so `.hover\:underline:hover` becomes `.hover\:underline` and `[data-x=":hover"]` stays.
 * Returns an invalid selector when a removal leaves a function argument empty (`:not(:hover)` becomes
 * `:not()`); querySelector then throws, and the rule is kept.
 *
 * Self-contained on purpose: scripts/screenshots.mjs sends this function's source into the page with
 * toString(), so everything it needs lives inside it.
 * @param {string} selectorText
 * @returns {string}
 */
export function cleanSelector(selectorText) {
	const UNTESTABLE = new Set([
		":hover",
		":focus",
		":focus-visible",
		":focus-within",
		":active",
		":visited",
		":before",
		":after",
		":first-line",
		":first-letter",
	]);
	const isNameChar = (ch) => /[\w-]/.test(ch) || ch >= "\u0080";
	// The index just past the identifier that starts at i (an escape is part of it).
	const identEnd = (text, i) => {
		let j = i;
		while (j < text.length) {
			if (text[j] === "\\") j += 2;
			else if (isNameChar(text[j])) j++;
			else break;
		}
		return Math.min(j, text.length);
	};
	// The index just past the ")" or "]" that closes the bracket opened at i.
	const closeOf = (text, i) => {
		let depth = 0;
		let quote = "";
		for (let j = i; j < text.length; j++) {
			const ch = text[j];
			if (ch === "\\") j++;
			else if (quote) {
				if (ch === quote) quote = "";
			} else if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "(" || ch === "[") depth++;
			else if (ch === ")" || ch === "]") {
				depth--;
				if (depth === 0) return j + 1;
			}
		}
		return text.length;
	};
	// A compound with its pseudo-elements and user-action pseudo-classes taken out.
	const takeOut = (text) => {
		let out = "";
		let bracket = 0;
		let quote = "";
		for (let i = 0; i < text.length; ) {
			const ch = text[i];
			if (ch === "\\") {
				out += text.slice(i, i + 2);
				i += 2;
				continue;
			}
			if (quote) {
				if (ch === quote) quote = "";
			} else if (ch === '"' || ch === "'") quote = ch;
			else if (ch === "[") bracket++;
			else if (ch === "]") bracket = Math.max(0, bracket - 1);
			else if (ch === ":" && bracket === 0) {
				let end = -1;
				if (text[i + 1] === ":") {
					end = identEnd(text, i + 2);
					if (text[end] === "(") end = closeOf(text, end);
				} else {
					const name = text.slice(i, identEnd(text, i + 1));
					if (UNTESTABLE.has(name.toLowerCase())) end = i + name.length;
				}
				if (end > i) {
					i = end;
					continue;
				}
			}
			out += ch;
			i++;
		}
		return out;
	};
	// Compounds and the separators between them (whitespace, >, + and ~ outside brackets) are cut
	// apart, so a compound that is emptied can become `*`. Commas outside brackets split the parts.
	let out = "";
	let run = "";
	let kind = "";
	let depth = 0;
	let quote = "";
	const flush = () => {
		out += kind === "compound" ? takeOut(run) || "*" : run;
		run = "";
		kind = "";
	};
	const add = (type, text) => {
		if (kind !== type) flush();
		kind = type;
		run += text;
	};
	for (let i = 0; i < selectorText.length; ) {
		const ch = selectorText[i];
		if (ch === "\\") {
			add("compound", selectorText.slice(i, i + 2));
			i += 2;
			continue;
		}
		if (quote) {
			add("compound", ch);
			if (ch === quote) quote = "";
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			add("compound", ch);
		} else if (depth === 0 && ch === ",") {
			flush();
			out += ",";
		} else if (depth === 0 && /[\s>+~]/.test(ch)) {
			add("separator", ch);
		} else {
			if (ch === "(" || ch === "[") depth++;
			else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
			add("compound", ch);
		}
		i++;
	}
	flush();
	return out;
}

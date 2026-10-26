// Fingerprints a page's load, so CI can tell which pages differ between `main` and the PR (decision 152).
// Pure: the page's HTML and its assets' hashes come in as plain values, so test/fingerprint.test.ts
// needs no browser and no server. scripts/screenshots.mjs does the loading and the hashing.

/**
 * A random v4 UUID, as crypto.randomUUID() makes one. Every load of a page draws new ones, so they
 * are taken out before two loads are compared.
 */
const V4_UUID =
	/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
const PLACEHOLDER = "<uuid>";

/**
 * The page's HTML with each per-request value replaced, so two loads of the same page on the same
 * data give the same string. Known sources: the Add cash entry key (src/routes/transactions.tsx:1772)
 * and the split sheet's sheet id and refund ids (src/views/split-form.tsx:267).
 * @param {string} html
 * @returns {string}
 */
export function normalizeDom(html) {
	return html.replace(V4_UUID, PLACEHOLDER);
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

/** Code-unit order, so sorting never depends on the locale. */
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A page's fingerprint: the SHA-256 of its normalized DOM and its same-origin assets (each one's
 * path and hash). The assets are sorted, so the order they loaded in doesn't matter; each is
 * reduced to `path` and `sha256`, so its keys always stringify the same way.
 * @param {{ dom: string, assets: { path: string, sha256: string }[] }} load
 * @returns {Promise<string>}
 */
export async function fingerprintOf({ dom, assets }) {
	const sorted = assets
		.map(({ path, sha256 }) => ({ path, sha256 }))
		.sort((a, b) => compare(a.path, b.path) || compare(a.sha256, b.sha256));
	return sha256Hex(JSON.stringify({ dom: normalizeDom(dom), assets: sorted }));
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

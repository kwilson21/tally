// Build-time patch for the vendored htmx 4.0.0 (decision 112, #471). Upstream RequestQueue.continue() frees the queue's
// slot unconditionally, so a request that was replaced (aborted) frees the slot its replacement now holds, and the next
// queued request runs beside that replacement. The patch frees a slot only while its own request still holds it.
// It changes htmx.js RequestQueue (about lines 90-127) and the end of #issueRequest (about lines 548-625).
// Delete this file, and its build:vendor step, when htmx ships a fix.
//
// patchHtmx(source) is pure. Run as a script, this writes public/vendor/htmx.min.js (npm run build:vendor).

const PATCHES = [
	{
		anchor: "continue(){this.#e=null,this.#t.shift()?.()}",
		replacement:
			"get current(){return this.#e}continue(s){if(s&&this.#e!==s)return;this.#e=null,this.#t.shift()?.()}",
	},
	{
		anchor:
			'if(this.#ae(t),"run"!==i.admit(r,()=>this.#se(e),()=>e.request?.abort?.()))return;',
		replacement:
			'if(this.#ae(t),"run"!==i.admit(r,()=>this.#se(e),()=>e.request?.abort?.()))return;let tallySlot=i.current;',
	},
	{
		anchor: "e.keepIndicators||(this.#pe(s),this.#ge(n)),i.continue()}",
		replacement:
			"e.keepIndicators||(this.#pe(s),this.#ge(n)),i.continue(tallySlot)}",
	},
];

/** The patched htmx source. Throws, naming the anchor, unless each anchor occurs exactly once. */
export function patchHtmx(source) {
	return PATCHES.reduce((text, { anchor, replacement }) => {
		const found = text.split(anchor).length - 1;
		if (found !== 1) {
			throw new Error(
				`patch-htmx: expected "${anchor}" once, found ${found}. htmx has moved this code; update scripts/patch-htmx.mjs.`,
			);
		}
		return text.replace(anchor, () => replacement);
	}, source);
}

if (process.argv[1]?.endsWith("patch-htmx.mjs")) {
	const { readFileSync, writeFileSync } = await import("node:fs");
	const source = readFileSync("node_modules/htmx.org/dist/htmx.min.js", "utf8");
	writeFileSync("public/vendor/htmx.min.js", patchHtmx(source));
}

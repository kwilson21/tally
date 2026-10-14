import htmxSource from "htmx.org/dist/htmx.min.js?raw";
import { describe, expect, it } from "vitest";
import { patchHtmx } from "../scripts/patch-htmx.mjs";

// Upstream code the patch replaces (decision 112, #471): each anchor occurs once in htmx 4.0.0's minified file.
const ANCHORS = [
	"continue(){this.#e=null,this.#t.shift()?.()}",
	'if(this.#ae(t),"run"!==i.admit(r,()=>this.#se(e),()=>e.request?.abort?.()))return;',
	"e.keepIndicators||(this.#pe(s),this.#ge(n)),i.continue()}",
];

// What each anchor becomes. Each must occur exactly once in the patched file.
const PATCHED = [
	"get current(){return this.#e}continue(s){if(s&&this.#e!==s)return;this.#e=null,this.#t.shift()?.()}",
	'if(this.#ae(t),"run"!==i.admit(r,()=>this.#se(e),()=>e.request?.abort?.()))return;let tallySlot=i.current;',
	"e.keepIndicators||(this.#pe(s),this.#ge(n)),i.continue(tallySlot)}",
];

const count = (text: string, part: string) => text.split(part).length - 1;

describe("patchHtmx", () => {
	it("applies each replacement to the vendored htmx exactly once", () => {
		const patched = patchHtmx(htmxSource);
		for (const replacement of PATCHED) {
			expect(count(patched, replacement)).toBe(1);
		}
		expect(patched).not.toContain("continue(){this.#e=null");
	});

	it("leaves a file that still parses as JavaScript", () => {
		expect(() => new Function(patchHtmx(htmxSource))).not.toThrow();
	});

	it("throws, naming the anchor, when the upstream code it changes has moved", () => {
		for (const anchor of ANCHORS) {
			expect(() => patchHtmx(htmxSource.replace(anchor, "moved"))).toThrow(
				anchor,
			);
		}
	});

	it("throws when an anchor occurs more than once", () => {
		expect(() => patchHtmx(`${htmxSource}\n${ANCHORS[0]}`)).toThrow(ANCHORS[0]);
	});
});

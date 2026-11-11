import { describe, expect, it } from "vitest";
import { peleSvg } from "../src/views/pele-diagram";

const SOURCE = `flowchart TB
  a["First"] --> b["Second"]
  class b undecided`;

describe("peleSvg", () => {
	it("is one labelled picture with the given title and description", () => {
		const svg = peleSvg(SOURCE, { id: "d", title: "A title", desc: "A desc." });
		expect(svg).toContain('role="img"');
		expect(svg).toContain('aria-labelledby="d-title d-desc"');
		expect(svg).toContain('<title id="d-title">A title</title>');
		expect(svg).toContain('<desc id="d-desc">A desc.</desc>');
		expect(svg).not.toContain("aria-roledescription");
	});

	it("keeps a dollar amount in the description as written", () => {
		const svg = peleSvg(SOURCE, {
			id: "d",
			title: "t",
			desc: "A $142.00 bill $1 $&",
		});

		expect(svg).toContain('<desc id="d-desc">A $142.00 bill $1 $&amp;</desc>');
	});

	it("escapes the title and description", () => {
		const svg = peleSvg(SOURCE, {
			id: "d",
			title: "<script>x</script>",
			desc: `a "b" & <i>`,
		});

		expect(svg).not.toContain("<script");
		expect(svg).toContain("&lt;script&gt;");
		expect(svg).toContain("&amp;");
	});

	it("has no style attribute, which the page's style-src 'self' would refuse", () => {
		const svg = peleSvg(SOURCE, { id: "d", title: "t", desc: "d" });
		expect(svg).not.toMatch(/\sstyle=/);
		expect(svg).not.toContain("<style");
	});

	it("keeps a node's class so app.css can dash or shade it", () => {
		const svg = peleSvg(SOURCE, { id: "d", title: "t", desc: "d" });
		expect(svg).toMatch(/class="pele-node [^"]*undecided"/);
	});

	it("uses only the colour variables app.css defines, so a Pele upgrade that adds one fails here", () => {
		const defined = new Set([
			"--_bg",
			"--_fg",
			"--_m",
			"--_l",
			"--_s",
			"--_a",
			"--_b",
			"--_c",
			"--_r",
			"--_fm",
			"--_w",
		]);

		for (const source of [
			SOURCE,
			`stateDiagram-v2\n  [*] --> a\n  a --> a: loop\n  a --> [*]`,
		]) {
			const svg = peleSvg(source, { id: "d", title: "t", desc: "d" });

			for (const [, name] of svg.matchAll(/var\((--_[a-z]+)/g))
				expect(defined.has(name as string)).toBe(true);
		}
	});

	it("draws no raw tag from diagram text", () => {
		const svg = peleSvg(
			`flowchart TB\n  a["<img src=x onerror=alert(1)>"] --> b["<script>1</script>"]`,
			{ id: "d", title: "t", desc: "d" },
		);

		expect(svg).not.toContain("<img");
		expect(svg).not.toContain("<script");
	});
});

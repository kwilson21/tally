import { describe, expect, it } from "vitest";
import { TallyMark } from "../src/views/brand";
import { ICON_NAMES, Icon } from "../src/views/icons";

describe("Icon", () => {
	it.each(ICON_NAMES)("renders %s as decorative inline SVG", async (name) => {
		const html = await Icon({ name }).toString();
		expect(html).toContain("<svg");
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('stroke="currentColor"');
	});
});

describe("TallyMark", () => {
	it("draws four strokes and one diagonal", async () => {
		const html = await TallyMark({}).toString();
		expect(html.match(/<line/g)?.length).toBe(5);
		expect(html).toContain('aria-hidden="true"');
	});
});

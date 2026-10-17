/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import { SplitLine } from "../src/views/split-form";

// Decision 128 (#676): the live amount is a figure in its own span; the words around it are prose. The line is a flex
// row for the check icon, so the sentence sits in one plain span inside it, and the figure is nested in that span.
const text = (html: string) => html.replace(/<[^>]+>/g, "");
/** The opening tags of the line, its sentence and its figures, in order. */
const tags = (html: string) => html.match(/<(?:p|span)\b[^>]*>/g) ?? [];

describe("SplitLine (decision 128)", () => {
	it("sets the amount left to assign in tabular figures, the words after it in normal ones", () => {
		const html = String(
			SplitLine({ parentCents: 1000, amounts: ["4.00", ""] }),
		);
		expect(html).toContain(
			'<span class="tabular-nums">$6.00</span> left to assign',
		);
		expect(html.match(/tabular-nums/g)).toHaveLength(1);
		const [line, sentence, figures] = tags(html);
		expect(line).not.toContain("tabular-nums");
		expect(sentence).toBe("<span>");
		expect(figures).toBe('<span class="tabular-nums">');
		expect(text(html)).toBe("$6.00 left to assign");
		expect(html).not.toContain('data-icon="check"');
	});

	it("sets the amount over in tabular figures, the word after it in normal ones", () => {
		const html = String(SplitLine({ parentCents: 1000, amounts: ["7", "4"] }));
		expect(html).toContain('<span class="tabular-nums">$1.00</span> over');
		expect(html.match(/tabular-nums/g)).toHaveLength(1);
		const [line, sentence] = tags(html);
		expect(line).not.toContain("tabular-nums");
		expect(sentence).toBe("<span>");
		expect(text(html)).toBe("$1.00 over");
	});

	it("sets the total in tabular figures when the parts add up, with the check icon", () => {
		const html = String(SplitLine({ parentCents: -1000, amounts: ["4", "6"] }));
		expect(html).toContain(
			'Adds up to <span class="tabular-nums">$10.00</span>',
		);
		expect(html.match(/tabular-nums/g)).toHaveLength(1);
		const [line, sentence, figures] = tags(html);
		expect(line).not.toContain("tabular-nums");
		expect(sentence).toBe("<span>");
		expect(figures).toBe('<span class="tabular-nums">');
		expect(text(html)).toBe("Adds up to $10.00");
		expect(html).toContain('data-icon="check"');
	});
});

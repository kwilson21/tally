import { describe, expect, it } from "vitest";
import { EmptyState } from "../src/views/empty-state";

const render = (props: Parameters<typeof EmptyState>[0]) =>
	String(EmptyState(props));

describe("EmptyState", () => {
	it.each(["search", "done"] as const)(
		"renders the %s drawing as decorative, with its sentence and hint",
		(kind) => {
			const html = render({
				kind,
				sentence: "Nothing here.",
				hint: "Try later.",
			});
			expect(html).toContain('aria-hidden="true"');
			expect(html).toContain("Nothing here.");
			expect(html).toContain("Try later.");
			expect(html).toContain('<p class="mt-3 text-lg">');
			expect(html).toContain('class="mt-1 max-w-xs text-muted"');
		},
	);

	it("shows the secondary button only when an action is supplied", () => {
		const withAction = render({
			kind: "search",
			sentence: "No matches.",
			action: { href: "/transactions", label: "Clear filters" },
		});
		expect(withAction).toMatch(
			/<a[^>]*href="\/transactions"[^>]*>Clear filters<\/a>/,
		);
		expect(withAction).toContain("border-ink");
		expect(render({ kind: "search", sentence: "No matches." })).not.toContain(
			"<a",
		);
	});

	it("renders a done state without a button", () => {
		const html = render({
			kind: "done",
			sentence: "Everything is finished.",
			hint: "New work appears here.",
		});
		expect(html).not.toContain("<button");
		expect(html).not.toContain("<a");
	});
});

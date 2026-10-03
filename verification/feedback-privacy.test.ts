import { describe, expect, it } from "vitest";
import {
	buildSafeScreenshotTree,
	installFeedbackMessageReview,
	safeFeedbackReturnPath,
	sanitizeFeedbackMessage,
	sanitizeFeedbackRoute,
	sanitizeReplayFixture,
} from "../src/feedback/privacy";

const canaries = [
	"Riley Example",
	"riley@example.test",
	"+1 (415) 555-0137",
	"42 Oak Street",
	"acct 123456789012",
	"$842.19 at Example Market",
	"token=FAKE_AUTH_SECRET_abcd01234",
	"Password: fake-secret-abcdef",
	"Authorization: Bearer fake-auth-token-98765",
];

describe("feedback minimization", () => {
	it("removes recognizable contact, address, account, transaction and URL details", () => {
		const cleaned = sanitizeFeedbackMessage(
			`${canaries.join(" | ")} https://tally.test/transactions?id=secret#private /transactions?merchant=secret#private`,
		);
		for (const canary of canaries) expect(cleaned).not.toContain(canary);
		expect(cleaned).not.toContain("id=secret");
		expect(cleaned).not.toContain("#private");
		expect(cleaned).not.toContain("merchant=secret");
	});

	it("redacts a recognizable name pattern without claiming arbitrary name detection", () => {
		expect(sanitizeFeedbackMessage("Riley Example said hello")).not.toContain(
			"Riley Example",
		);
		expect(sanitizeFeedbackMessage("riley example said hello")).toContain(
			"riley example",
		);
	});

	it("is idempotent and leaves ordinary card descriptions intact", () => {
		for (const sample of [
			"account 123456789",
			"acct 123456789012",
			"card failed",
			"Card failed while loading",
			...canaries,
			"https://tally.test/transactions?id=secret#private",
		]) {
			const cleaned = sanitizeFeedbackMessage(sample);
			expect(sanitizeFeedbackMessage(cleaned)).toBe(cleaned);
		}
		expect(sanitizeFeedbackMessage("Card failed while loading")).toBe(
			"Card failed while loading",
		);
	});

	it("maps URLs to approved route templates and drops identifiers and query data", () => {
		expect(sanitizeFeedbackRoute("/transactions/tx_123?q=Riley#secret")).toBe(
			"/transactions",
		);
		expect(sanitizeFeedbackRoute("/private/household/42")).toBe("/other");
	});

	it("preserves a validated same-origin return query while dropping fragments", () => {
		expect(safeFeedbackReturnPath("/transactions?adjust=1#private")).toBe(
			"/transactions?adjust=1",
		);
		expect(safeFeedbackReturnPath("/?adjust=1#private")).toBe("/?adjust=1");
		expect(safeFeedbackReturnPath("//evil.test/transactions?q=secret")).toBe(
			"/",
		);
		expect(
			safeFeedbackReturnPath("https://evil.test/transactions?q=secret"),
		).toBe("/");
	});
});

describe("cleaned-message confirmation", () => {
	it("shows the sanitized message before allowing submission and rechecks edits", () => {
		const listeners = new Map<
			string,
			(event: { preventDefault(): void }) => void
		>();
		const inputListeners = new Map<string, () => void>();
		const children: Array<{ textContent?: string }> = [];
		const message = {
			value: "account 123456789 and Card failed",
			addEventListener: (name: string, callback: () => void) =>
				inputListeners.set(name, callback),
			focus: () => {},
		};
		const review = {
			hidden: true,
			replaceChildren: () => {
				children.length = 0;
			},
			append: (...items: Array<{ textContent?: string }>) =>
				children.push(...items),
		};
		const form = {
			querySelector: (selector: string) =>
				selector.includes("message") ? message : null,
			addEventListener: (
				name: string,
				callback: (event: { preventDefault(): void }) => void,
			) => listeners.set(name, callback),
		};
		const doc = {
			querySelector: (selector: string) =>
				selector.startsWith("form") ? form : review,
			createElement: () => ({ textContent: "" }),
		};
		installFeedbackMessageReview(doc as never);
		let prevented = false;
		listeners.get("submit")?.({
			preventDefault: () => {
				prevented = true;
			},
		});
		expect(prevented).toBe(true);
		expect(message.value).toContain("[account detail removed]");
		expect(message.value).toContain("Card failed");
		expect(review.hidden).toBe(false);
		expect(children[1]?.textContent).toBe(message.value);
		prevented = false;
		listeners.get("submit")?.({
			preventDefault: () => {
				prevented = true;
			},
		});
		expect(prevented).toBe(false);
		inputListeners.get("input")?.();
		prevented = false;
		listeners.get("submit")?.({
			preventDefault: () => {
				prevented = true;
			},
		});
		expect(prevented).toBe(true);
	});
});

describe("safe screenshot tree", () => {
	it("keeps only reviewed static copy and allowlisted layout styling", () => {
		const tree = buildSafeScreenshotTree({
			tagName: "BODY",
			attributes: {
				"data-feedback-capture-layout": "viewport",
				class: "secret",
			},
			children: [
				{
					tagName: "NAV",
					attributes: {
						"data-feedback-capture-layout": "sidebar-nav",
						class: "dynamic-user-class",
						href: "/transactions?q=secret",
					},
					styles: {
						display: "flex",
						backgroundImage: 'url("https://private")',
					},
					children: [
						{
							tagName: "SPAN",
							attributes: { "data-feedback-capture-copy": "nav-transactions" },
							textContent: "Transactions",
							styles: {
								color: "rgb(1, 2, 3)",
								backgroundImage: 'url("private")',
							},
						},
						{
							tagName: "SPAN",
							textContent: "Riley Example riley@example.test",
						},
						{
							tagName: "INPUT",
							attributes: { type: "hidden", value: "secret" },
						},
						{
							tagName: "CANVAS",
							attributes: { "data-feedback-capture-copy": "nav-home" },
							textContent: "Riley Example",
						},
					],
				},
				{
					tagName: "IMG",
					attributes: { src: "https://private/image.png" },
				},
			],
		});
		const serialized = JSON.stringify(tree);
		expect(serialized).toContain("Transactions");
		expect(serialized).not.toContain("Riley");
		expect(serialized).not.toContain("riley@example.test");
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("url(");
		expect(serialized).not.toContain("dynamic-user-class");
	});

	it("fails closed if approved static text has unexpected dynamic descendants", () => {
		expect(() =>
			buildSafeScreenshotTree({
				tagName: "SPAN",
				attributes: { "data-feedback-capture-copy": "nav-home" },
				textContent: "Home Riley Example",
				children: [{ tagName: "B", textContent: "riley@example.test" }],
			}),
		).toThrow();
	});
});

describe("PostHog replay payload policy", () => {
	it("drops copied text, hidden fields, attributes, URL query/hash, network and console data", () => {
		const output = sanitizeReplayFixture({
			url: "https://tally.test/transactions/record-123?merchant=Riley#secret",
			kind: "click",
			target: "nav-transactions",
			properties: {
				$current_url: "https://tally.test/?email=riley@example.test",
				message: "Riley Example",
			},
			nodes: [
				{ tagName: "SPAN", copyId: "nav-transactions", text: "Transactions" },
				{ tagName: "SPAN", text: "Riley Example riley@example.test" },
				{ tagName: "INPUT", type: "hidden", value: "/?return_to=secret" },
			],
			network: [
				{ url: "https://api.test/?token=secret", body: "account 123456789" },
			],
			console: ["Riley Example", "stack secret"],
		});
		const serialized = JSON.stringify(output);
		expect(serialized).toContain("Transactions");
		for (const secret of [
			"Riley",
			"riley@example.test",
			"secret",
			"123456789",
			"network",
			"console",
			"record-123",
		])
			expect(serialized).not.toContain(secret);
		expect(output.route).toBe("/transactions");
		expect(output.kind).toBe("click");
	});
});

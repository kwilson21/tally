import { describe, expect, it, vi } from "vitest";
import { setupPlaidLink } from "../public/js/plaid-link.js";

describe("plaid-link.js", () => {
	it("creates a link token, exchanges the public token as a form, and logs neither", async () => {
		let click: () => Promise<void> = async () => {};
		let linkOptions:
			| { onSuccess: (token: string) => Promise<void> }
			| undefined;
		const listeners = new Map();
		const button = {
			disabled: false,
			setAttribute: vi.fn(),
			classList: { toggle: vi.fn() },
			addEventListener: (
				name: string,
				listener: (...args: never[]) => unknown,
			) => {
				if (name === "click") click = listener as () => Promise<void>;
				else listeners.set(name, listener);
			},
			removeEventListener: vi.fn(),
		};
		const errorRegion = { replaceChildren: vi.fn() };
		const document = {
			querySelector: (selector: string) =>
				selector === "[data-link-bank]" ? button : errorRegion,
			createElement: vi.fn(),
		};
		const fetch = vi.fn(async () => ({
			ok: true,
			json: async () => ({ link_token: "link-secret" }),
		}));
		const ajax = vi.fn(async (method: string) => {
			if (method === "POST") {
				listeners.get("htmx:finally:request")?.({
					detail: { ctx: { response: { status: 204 }, text: "" } },
				});
			}
		});
		const open = vi.fn();
		const create = vi.fn((options) => {
			linkOptions = options;
			return { open };
		});
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		setupPlaidLink({
			document,
			fetch,
			Plaid: { create },
			htmx: { ajax },
			DOMParser: class {},
		});
		await click();
		expect(fetch).toHaveBeenCalledWith("/plaid/link-token", { method: "POST" });
		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({ token: "link-secret" }),
		);
		expect(open).toHaveBeenCalledOnce();

		await linkOptions?.onSuccess("public-secret");
		expect(ajax).toHaveBeenNthCalledWith(
			1,
			"POST",
			"/plaid/exchange",
			expect.objectContaining({
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
				values: { public_token: "public-secret" },
			}),
		);
		expect(ajax).toHaveBeenNthCalledWith(
			2,
			"GET",
			"/accounts",
			expect.objectContaining({ select: "#accounts-banks" }),
		);
		expect(consoleSpy).not.toHaveBeenCalled();
		consoleSpy.mockRestore();
	});
});

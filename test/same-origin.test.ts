import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const post = (headers: Record<string, string>) =>
	exports.default.fetch("http://tally.test/transactions/1", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			...headers,
		},
		body: "note=hi",
	});

describe("form posts from other sites (Hono csrf)", () => {
	it("rejects a form post from another site", async () => {
		expect((await post({ Origin: "https://evil.example" })).status).toBe(403);
	});

	it("allows a post from this site", async () => {
		expect((await post({ Origin: "http://tally.test" })).status).not.toBe(403);
	});

	it("rejects a form post that can't show it came from this site", async () => {
		expect((await post({})).status).toBe(403);
	});

	it("allows a post the browser marks as same-origin", async () => {
		expect((await post({ "Sec-Fetch-Site": "same-origin" })).status).not.toBe(
			403,
		);
	});

	it("never blocks reads", async () => {
		const res = await exports.default.fetch("http://tally.test/transactions", {
			headers: { Origin: "https://evil.example" },
		});
		expect(res.status).toBe(200);
	});
});

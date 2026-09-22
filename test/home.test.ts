import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("GET /", () => {
	it("renders an HTML page titled Tally", async () => {
		const response = await exports.default.fetch("http://tally.test/");
		const html = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(html).toContain("<title>Tally</title>");
		expect(html).toContain('<html lang="en">');
	});
});

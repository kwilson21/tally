import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, todayIn } from "../src/dates";
import { readFirstTally } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { accounts } from "../src/routes/accounts";
import { recordSorting } from "./record-sorting";

recordSorting({ sort: true });

const TODAY = todayIn(DEFAULT_TIME_ZONE);
const family = { ...env, DEMO: "false" } as unknown as Env;
const HEADER =
	"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)";
// Made-up rows in Apple's layout (spec §8.10): the Rivera family's store, a card ending 1234, never a real export.
const ROW_A =
	'09/10/2026,09/11/2026,"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA","Greenleaf Market #12","Grocery","Purchase","38.40"';
const ROW_B =
	'09/12/2026,09/13/2026,"THAI PALACE 4 OAK ST SPRINGFIELD 00000 XX USA","Thai Palace","Restaurants","Purchase","24.10"';
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

// The actor the family's sign-in sets (the accounts app reads it for `updated_by`).
const app = new Hono<{ Bindings: Env; Variables: { actor: string } }>();
app.use("*", async (c, next) => {
	c.set("actor", "family@example.com");
	await next();
});
app.route("/", accounts);

const ctx = () => ({
	waitUntil: vi.fn<(promise: Promise<unknown>) => void>((promise) => {
		void promise.catch(() => {});
	}),
	passThroughOnException() {},
	props: {},
});

/** A multipart form, sent as bytes with an explicit Content-Length, as a browser sends it. */
async function multipart(fields: Record<string, string | File>) {
	const form = new FormData();
	for (const [name, value] of Object.entries(fields)) form.set(name, value);
	const request = new Request("http://tally.test/accounts/apple-card", {
		method: "POST",
		body: form,
	});
	return {
		type: request.headers.get("content-type") ?? "",
		bytes: await request.arrayBuffer(),
	};
}

function file(text: string, name = "apple.csv") {
	return new File([text], name, { type: "text/csv" });
}

async function post(
	fields: Record<string, string | File>,
	options: { htmx?: boolean; contentLength?: string; bindings?: Env } = {},
) {
	const { type, bytes } = await multipart(fields);
	const headers: Record<string, string> = {
		"content-type": type,
		"content-length": options.contentLength ?? String(bytes.byteLength),
	};
	if (options.htmx) headers["HX-Request"] = "true";
	const res = await app.request(
		"/accounts/apple-card",
		{ method: "POST", headers, body: bytes },
		options.bindings ?? family,
		ctx(),
	);
	const html = (await res.text()).replaceAll("&#39;", "'");
	return { res, html };
}

/** A body that throws when anything reads it: a refusal that reads no body never sees this. */
const unreadable = () =>
	new ReadableStream({
		pull() {
			throw new Error("the body was read");
		},
	});

async function postUnread(contentLength: string, htmx = false) {
	const headers: Record<string, string> = {
		"content-type": "multipart/form-data; boundary=x",
		"content-length": contentLength,
	};
	if (htmx) headers["HX-Request"] = "true";
	const res = await app.request(
		"/accounts/apple-card",
		{
			method: "POST",
			headers,
			body: unreadable(),
			duplex: "half",
		} as RequestInit,
		family,
		ctx(),
	);
	return { res, html: (await res.text()).replaceAll("&#39;", "'") };
}

const cardRows = () =>
	env.DB.prepare(
		"SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card'",
	).first<{ n: number }>();
const cardAccount = () =>
	env.DB.prepare(
		"SELECT balance_cents, balance_on, uploaded_on, removed_at, counted_from FROM accounts WHERE subtype = 'apple_card'",
	).first<{
		balance_cents: number;
		balance_on: string | null;
		uploaded_on: string | null;
		removed_at: string | null;
		counted_from: string | null;
	}>();

describe("Apple Card's upload sheet (#766)", () => {
	beforeEach(async () => {
		vi.restoreAllMocks();
		await resetDemo(env.DB, TODAY);
	});

	describe("GET /accounts/apple-card", () => {
		it("returns the sheet in #sheet with the file field and the balance, for htmx", async () => {
			const res = await app.request(
				"/accounts/apple-card",
				{ headers: { "HX-Request": "true" } },
				family,
			);
			const html = (await res.text()).replaceAll("&#39;", "'");
			expect(html).toContain('id="sheet"');
			expect(html).toContain('id="apple-card-file"');
			expect(html).toContain("Apple Card file (CSV)");
			expect(html).toContain("Balance in Wallet");
			expect(html).toContain("Upload a file");
			expect(html).toContain('enctype="multipart/form-data"');
			expect(html).toContain('hx-encoding="multipart/form-data"');
			expect(html).toContain("hx-disable=");
		});

		it("returns Accounts with the sheet open, without htmx", async () => {
			const res = await app.request("/accounts/apple-card", {}, family);
			const html = await res.text();
			expect(html).toContain("<h1");
			expect(html).toContain('id="apple-card-sheet-title"');
		});

		it("is the link Upload a file and Add Apple Card open (sheetAttrs)", async () => {
			const html = (
				await (await app.request("/accounts", {}, family)).text()
			).replaceAll("&#39;", "'");
			expect(html).toContain('hx-get="/accounts/apple-card"');
		});
	});

	describe("POST /accounts/apple-card, a good file", () => {
		it("adds its rows, redraws Accounts with a toast and focus on Upload a file, and pushes /accounts", async () => {
			const { res, html } = await post(
				{ file: file(csv(ROW_A, ROW_B)), balance: "" },
				{ htmx: true },
			);
			expect(res.status).toBe(200);
			expect(res.headers.get("HX-Push-Url")).toBe("/accounts");
			expect(res.headers.get("HX-Trigger")).toContain(
				"Added 2 from Apple Card.",
			);
			expect(html).toContain('id="accounts-summary"');
			expect(html).toMatch(/<a [^>]*autofocus[^>]*>/);
			expect(await cardRows()).toEqual({ n: 2 });
		});

		it("answers 303 to /accounts without htmx, as Savings does", async () => {
			const { res } = await post({ file: file(csv(ROW_A)), balance: "" });
			expect(res.status).toBe(303);
			expect(res.headers.get("Location")).toBe("/accounts");
			expect(await cardRows()).toEqual({ n: 1 });
		});

		it("says Nothing new when the same file comes again, and adds nothing", async () => {
			await post(
				{ file: file(csv(ROW_A, ROW_B)), balance: "" },
				{ htmx: true },
			);
			const { res } = await post(
				{ file: file(csv(ROW_A, ROW_B)), balance: "" },
				{ htmx: true },
			);
			expect(res.headers.get("HX-Trigger")).toContain(
				"Nothing new. All 2 were already in Tally.",
			);
			expect(await cardRows()).toEqual({ n: 2 });
		});

		it("saves a typed balance as the card's, dated today, and records who uploaded it", async () => {
			await post(
				{ file: file(csv(ROW_A)), balance: "1,240.18" },
				{ htmx: true },
			);
			const card = await cardAccount();
			expect(card).toMatchObject({
				balance_cents: 124018,
				balance_on: TODAY,
				uploaded_on: TODAY,
				removed_at: null,
			});
			expect(card?.counted_from).toBe(TODAY);
			const by = await env.DB.prepare(
				"SELECT t.updated_by AS by FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.subtype = 'apple_card' LIMIT 1",
			).first<{ by: string }>();
			expect(by?.by).toBe("family@example.com");
		});

		it("keeps the balance and its day when a later upload leaves the balance blank", async () => {
			await post(
				{ file: file(csv(ROW_A)), balance: "1,240.18" },
				{ htmx: true },
			);
			await post(
				{ file: file(csv(ROW_A, ROW_B)), balance: "" },
				{ htmx: true },
			);
			expect(await cardAccount()).toMatchObject({
				balance_cents: 124018,
				balance_on: TODAY,
			});
		});

		it("stores a credit typed with a minus, as a negative amount owed", async () => {
			await post({ file: file(csv(ROW_A)), balance: "-12.00" }, { htmx: true });
			expect((await cardAccount())?.balance_cents).toBe(-1200);
		});
	});

	describe("POST /accounts/apple-card, refusals", () => {
		it("refuses a request with an unreadable Content-Length before its body is read, with its own words", async () => {
			const { res, html } = await postUnread("abc");
			expect(res.status).toBe(422);
			expect(html).toContain(
				"Tally couldn't tell how big this file is. Try the upload again.",
			);
			expect(html).toContain('role="alert"');
		});

		it("refuses a request over 1,100,000 bytes before its body is read, with the too-big words", async () => {
			const { res, html } = await postUnread("1100001");
			expect(res.status).toBe(422);
			expect(html).toContain(
				"This file is over 1 MB. An Apple Card CSV is far smaller, so check it's the right file.",
			);
		});

		it("answers an htmx refusal of the size gate with HX-Reswap none and one error toast, keeping the page", async () => {
			const { res } = await postUnread("2000000", true);
			expect(res.status).toBe(422);
			expect(res.headers.get("HX-Reswap")).toBe("none");
			expect(res.headers.get("HX-Trigger")).toContain('"type":"error"');
			expect(res.headers.get("HX-Trigger")).toContain(
				"This file is over 1 MB.",
			);
			expect(await cardRows()).toEqual({ n: 0 });
		});

		it("refuses a file over 1 MB after it's read, under the file field, saving nothing", async () => {
			const padded = `${csv(ROW_A)}\n${"x".repeat(1_000_001)}`;
			const { res, html } = await post(
				{ file: file(padded), balance: "" },
				{ htmx: true },
			);
			expect(res.status).toBe(422);
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain("This file is over 1 MB.");
			expect(html).toContain('role="alert"');
			expect(await cardRows()).toEqual({ n: 0 });
		});

		it("refuses another file under the file field, and keeps the typed balance", async () => {
			const { res, html } = await post(
				{ file: file("OFXHEADER:100\n<OFX>"), balance: "1,240.18" },
				{ htmx: true },
			);
			expect(res.status).toBe(422);
			expect(html).toContain(
				"This isn't an Apple Card CSV. In Wallet or on card.apple.com, choose Export Transactions and pick CSV.",
			);
			expect(html).toContain('value="1,240.18"');
			expect(await cardAccount()).toBeFalsy();
		});

		it("names the row it can't read, and saves nothing", async () => {
			const bad = csv(
				ROW_A,
				'09/12/2026,09/13/2026,"THAI PALACE","Thai Palace","Restaurants","Purchase","$24.10"',
			);
			const { res, html } = await post(
				{ file: file(bad), balance: "" },
				{ htmx: true },
			);
			expect(res.status).toBe(422);
			// A refusal after the body is read sends no toast: the alert under the field is what's announced.
			expect(res.headers.get("HX-Trigger")).toBeNull();
			expect(html).toContain(
				"Row 3's amount can't be read. Nothing was added.",
			);
			expect(await cardRows()).toEqual({ n: 0 });
		});

		it("says to choose a file when none is sent", async () => {
			const { res, html } = await post({ balance: "" }, { htmx: true });
			expect(res.status).toBe(422);
			expect(html).toContain("Choose the CSV file Apple exported.");
		});

		it("refuses a balance that can't be read, under the balance, and focuses it", async () => {
			const { res, html } = await post(
				{ file: file(csv(ROW_A)), balance: "12.3.4" },
				{ htmx: true },
			);
			expect(res.status).toBe(422);
			expect(html).toContain(
				"Enter the balance as dollars, like 1,240.18, or with a minus for a credit.",
			);
			expect(html).toMatch(/<input [^>]*id="apple-card-balance"[^>]*autofocus/);
			expect(await cardRows()).toEqual({ n: 0 });
		});

		it("shows both errors when both fields are wrong, and focuses the file field", async () => {
			const { html } = await post({ balance: "12.3.4" }, { htmx: true });
			expect(html).toContain("Choose the CSV file Apple exported.");
			expect(html).toContain("Enter the balance as dollars");
			expect(html).toMatch(/<input [^>]*id="apple-card-file"[^>]*autofocus/);
			expect(html).not.toMatch(
				/<input [^>]*id="apple-card-balance"[^>]*autofocus/,
			);
		});

		it("says Link a bank first when there is no bank and no card to start Tally's history from", async () => {
			await env.DB.batch([
				env.DB.prepare("DELETE FROM transactions"),
				env.DB.prepare("DELETE FROM accounts"),
				env.DB.prepare("DELETE FROM plaid_items"),
			]);
			const { html } = await post(
				{ file: file(csv(ROW_A)), balance: "" },
				{ htmx: true },
			);
			expect(html).toContain(
				"Link a bank first. Tally's history starts with your bank's.",
			);
			expect(await cardAccount()).toBeFalsy();
		});
	});

	describe("Accounts with Apple Card", () => {
		it("shows the group after the banks, then the buttons, the error region, and #sheet last", async () => {
			await post(
				{ file: file(csv(ROW_A, ROW_B)), balance: "1,240.18" },
				{ htmx: true },
			);
			const plaid = {
				...family,
				PLAID_CLIENT_ID: "client",
				PLAID_SECRET: "secret",
				TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
			} as unknown as Env;
			const html = (
				await (await app.request("/accounts", {}, plaid)).text()
			).replaceAll("&#39;", "'");
			const banks = html.indexOf('id="accounts-banks"');
			const group = html.indexOf("data-apple-card");
			const link = html.indexOf("data-link-bank");
			const error = html.indexOf("data-link-bank-error");
			const sheet = html.indexOf('id="sheet"');
			expect(banks).toBeGreaterThan(-1);
			expect(group).toBeGreaterThan(banks);
			expect(link).toBeGreaterThan(group);
			expect(error).toBeGreaterThan(link);
			expect(sheet).toBeGreaterThan(error);
		});

		it("shows Upload a file under the card's row, with Manage holding Remove in the family app", async () => {
			await post(
				{ file: file(csv(ROW_A)), balance: "1,240.18" },
				{ htmx: true },
			);
			const html = (
				await (await app.request("/accounts", {}, family)).text()
			).replaceAll("&#39;", "'");
			expect(html).toContain("Updated through Sep 11");
			expect(html).toContain("Balance as of");
			expect(html).toContain("Upload a file");
			expect(html).toContain("Remove Apple Card");
		});

		it("says the card isn't in net worth yet while no balance counts", async () => {
			await post({ file: file(csv(ROW_A)), balance: "" }, { htmx: true });
			const html = (
				await (await app.request("/accounts", {}, family)).text()
			).replaceAll("&#39;", "'");
			expect(html).toContain(
				"Apple Card isn't in net worth yet. Add its balance next time you upload.",
			);
		});

		it("offers Add Apple Card once a bank is linked and there's no card, and no empty state", async () => {
			const html = (
				await (await app.request("/accounts", {}, family)).text()
			).replaceAll("&#39;", "'");
			expect(html).toContain("Add Apple Card");
			expect(html).not.toContain("No banks linked yet.");
		});

		it("draws Cancel as a link back to /accounts?focus=apple-card, which toasts the cancel for htmx", async () => {
			const res = await app.request(
				"/accounts?focus=apple-card",
				{ headers: { "HX-Request": "true" } },
				family,
			);
			expect(res.headers.get("HX-Trigger")).toContain(
				"Apple Card upload cancelled.",
			);
			const html = await res.text();
			expect(html).toMatch(/<a [^>]*autofocus[^>]*>/);
		});

		it("offers Add Apple Card and draws the removed group with no bank, once the card is removed", async () => {
			await post(
				{ file: file(csv(ROW_A)), balance: "1,240.18" },
				{ htmx: true },
			);
			// Remove Apple Card keeps its rows and clears its balance, so the card is off and no bank is linked.
			await env.DB.batch([
				env.DB.prepare(
					"DELETE FROM balance_history WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL)",
				),
				env.DB.prepare(
					"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL)",
				),
				env.DB.prepare("DELETE FROM accounts WHERE plaid_item_id IS NOT NULL"),
				env.DB.prepare("DELETE FROM plaid_items"),
				env.DB.prepare(
					"UPDATE accounts SET removed_at = datetime('now'), balance_on = NULL WHERE subtype = 'apple_card'",
				),
			]);
			const html = (
				await (await app.request("/accounts", {}, family)).text()
			).replaceAll("&#39;", "'");
			// Add Apple Card shows again, since the card is removed, whatever the banks are (spec §8.10).
			expect(html).toMatch(
				/<a [^>]*href="\/accounts\/apple-card"[^>]*>\s*Add Apple Card/,
			);
			// The removed card's group is drawn like a disconnected bank's: its name and "Removed", no Upload.
			const group =
				html.split("data-apple-card")[1]?.split("</section>")[0] ?? "";
			expect(group).toContain("Removed");
			expect(group).not.toContain("Upload a file");
		});

		it("draws the card alone, with net worth and the group, when no bank is linked", async () => {
			await post(
				{ file: file(csv(ROW_A)), balance: "1,240.18" },
				{ htmx: true },
			);
			await env.DB.batch([
				env.DB.prepare(
					"DELETE FROM balance_history WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL)",
				),
				env.DB.prepare(
					"DELETE FROM transactions WHERE account_id IN (SELECT id FROM accounts WHERE plaid_item_id IS NOT NULL)",
				),
				env.DB.prepare("DELETE FROM accounts WHERE plaid_item_id IS NOT NULL"),
				env.DB.prepare("DELETE FROM plaid_items"),
			]);
			const html = (
				await (await app.request("/accounts", {}, family)).text()
			).replaceAll("&#39;", "'");
			expect(html).not.toContain("No banks linked yet.");
			expect(html).toContain("Apple Card");
			expect(html).toContain("Upload a file");
		});
	});
});

describe("the first week is untouched by an upload (spec §8.10, #766)", () => {
	it("leaves the first-week record as it was, so an upload draws no stroke", async () => {
		await resetDemo(env.DB, TODAY);
		const before = await readFirstTally(env.DB);
		const csv = [
			"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)",
			'09/10/2026,09/11/2026,"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA","Greenleaf Market #12","Grocery","Purchase","38.40"',
		].join("\n");
		const form = new FormData();
		form.set("file", new File([csv], "apple.csv", { type: "text/csv" }));
		form.set("balance", "1,240.18");
		const request = new Request("http://tally.test/accounts/apple-card", {
			method: "POST",
			body: form,
		});
		const bytes = await request.arrayBuffer();
		const res = await app.request(
			"/accounts/apple-card",
			{
				method: "POST",
				headers: {
					"content-type": request.headers.get("content-type") ?? "",
					"content-length": String(bytes.byteLength),
					"HX-Request": "true",
				},
				body: bytes,
			},
			family,
			ctx(),
		);
		expect(res.status).toBe(200);
		expect(await readFirstTally(env.DB)).toEqual(before);
	});
});

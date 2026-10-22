import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TIME_ZONE, daysBefore, shortDay, todayIn } from "../src/dates";
import { isSetUp, readFirstTally } from "../src/db/first-tally";
import { resetDemo } from "../src/demo/reset";
import { readGateInputs } from "../src/first-tally/gate";
import { accounts } from "../src/routes/accounts";
import type { SortParams } from "../src/sort-start";
import { recordSorting } from "./record-sorting";

recordSorting({ sort: true });

const TODAY = todayIn(DEFAULT_TIME_ZONE);
const family = { ...env, DEMO: "false" } as unknown as Env;
const HEADER =
	"Transaction Date,Clearing Date,Description,Merchant,Category,Type,Amount (USD)";
/** Apple's MM/DD/YYYY for a YYYY-MM-DD day. */
const apple = (day: string) =>
	`${day.slice(5, 7)}/${day.slice(8, 10)}/${day.slice(0, 4)}`;
// The rows are dated from the real today, so they stay inside Tally's history whenever this runs (never a fixed date).
const CLEARED_A = daysBefore(TODAY, 10);
// Made-up rows in Apple's layout (spec §8.10): the Rivera family's store, a card ending 1234, never a real export.
const ROW_A = `${apple(daysBefore(TODAY, 11))},${apple(CLEARED_A)},"GREENLEAF MARKET #12 100 MAIN ST SPRINGFIELD 00000 XX USA","Greenleaf Market #12","Grocery","Purchase","38.40"`;
const ROW_B = `${apple(daysBefore(TODAY, 9))},${apple(daysBefore(TODAY, 8))},"THAI PALACE 4 OAK ST SPRINGFIELD 00000 XX USA","Thai Palace","Restaurants","Purchase","24.10"`;
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

/**
 * A body that throws when it is read, and says whether it was: `pulled` is set only by a read, because highWaterMark 0
 * keeps the stream from pulling on its own (a default stream pulls at once, so its flag would say nothing).
 */
function unreadable() {
	const state = { pulled: false };
	const stream = new ReadableStream(
		{
			pull() {
				state.pulled = true;
				throw new Error("the body was read");
			},
		},
		{ highWaterMark: 0 },
	);
	return { stream, state };
}

async function postUnread(contentLength: string, htmx = false) {
	const headers: Record<string, string> = {
		"content-type": "multipart/form-data; boundary=x",
		"content-length": contentLength,
	};
	if (htmx) headers["HX-Request"] = "true";
	const body = unreadable();
	const res = await app.request(
		"/accounts/apple-card",
		{
			method: "POST",
			headers,
			body: body.stream,
			duplex: "half",
		} as RequestInit,
		family,
		ctx(),
	);
	return {
		res,
		html: (await res.text()).replaceAll("&#39;", "'"),
		/** False when the refusal never read the body. */
		pulled: body.state.pulled,
	};
}

/** The submit's own label: its first span holds it, and the second holds the busy label. */
const submitLabel = (html: string) =>
	html.match(
		/<button[^>]*id="apple-card-upload"[^>]*>\s*<span class="contents[^"]*">([^<]*)<\/span>/,
	)?.[1];

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
		it("returns the whole Accounts page for htmx, with the sheet in #sheet, as Savings' sheet GETs do", async () => {
			const res = await app.request(
				"/accounts/apple-card",
				{ headers: { "HX-Request": "true" } },
				family,
			);
			const html = (await res.text()).replaceAll("&#39;", "'");
			// The opener's hx-select="#sheet" takes only the sheet out of the page, and Back can restore the whole page.
			expect(html).toContain("<main");
			expect(html).toContain('id="accounts-summary"');
			const sheet = html.slice(html.indexOf('id="sheet"'));
			expect(sheet).toContain('id="apple-card-file"');
			expect(sheet).toContain("Apple Card file (CSV)");
			expect(sheet).toContain("Balance in Wallet");
			// The submit says Upload (spec §8.10: Cancel and Upload). "Upload a file" is the group's button that opens this sheet.
			expect(submitLabel(html)).toBe("Upload");
			expect(sheet).not.toContain("Upload a file");
			expect(sheet).toContain('enctype="multipart/form-data"');
			expect(sheet).toContain('hx-encoding="multipart/form-data"');
			expect(sheet).toContain("hx-disable=");
		});

		it("answers a history restore (Back or Forward) with the whole page, so the nav and the summary come back", async () => {
			// htmx restores a history entry by swapping the whole body with this answer (outerSync), so a bare sheet would empty it.
			const res = await app.request(
				"/accounts/apple-card",
				{
					headers: {
						"HX-Request": "true",
						"HX-History-Restore-Request": "true",
					},
				},
				family,
			);
			const html = await res.text();
			expect(res.status).toBe(200);
			expect(html).toContain("<main");
			expect(html).toContain('id="accounts-summary"');
			expect(html).toContain('id="toasts"');
			expect(html).toContain('id="announcer"');
			expect(html.split('id="sheet"').length - 1).toBe(1);
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

		it("hands the rows it added to the sorting Workflow once, and none when it adds nothing", async () => {
			// The sorting binding is a plain recorder here, so no instance runs; the key lets the start go ahead.
			const create = vi.fn<(input: { params: SortParams }) => Promise<unknown>>(
				async () => ({ id: "fake" }),
			);
			const bindings = {
				...family,
				JEV_API_KEY: "test-key",
				SORT: { create },
			} as unknown as Env;
			await post(
				{ file: file(csv(ROW_A, ROW_B)), balance: "" },
				{ htmx: true, bindings },
			);
			expect(create).toHaveBeenCalledTimes(1);
			const params = create.mock.calls[0]?.[0].params;
			expect(params?.bySync).toBe(true);
			expect(params?.ids).toHaveLength(2);
			// The same file again adds nothing, so there is nothing to sort.
			await post(
				{ file: file(csv(ROW_A, ROW_B)), balance: "" },
				{ htmx: true, bindings },
			);
			expect(create).toHaveBeenCalledTimes(1);
		});
	});

	describe("POST /accounts/apple-card, refusals", () => {
		it("refuses a request with an unreadable Content-Length before its body is read, with its own words", async () => {
			const { res, html, pulled } = await postUnread("abc");
			expect(res.status).toBe(422);
			expect(html).toContain(
				"Tally couldn't tell how big this file is. Try the upload again.",
			);
			expect(html).toContain('role="alert"');
			expect(pulled).toBe(false);
		});

		it("refuses a request over 1,100,000 bytes before its body is read, with the too-big words", async () => {
			const { res, html, pulled } = await postUnread("1100001");
			expect(res.status).toBe(422);
			expect(html).toContain(
				"This file is over 1 MB. An Apple Card CSV is far smaller, so check it's the right file.",
			);
			expect(pulled).toBe(false);
		});

		it("answers an htmx refusal of the size gate with HX-Reswap none and one error toast, keeping the page", async () => {
			const { res, pulled } = await postUnread("2000000", true);
			expect(res.status).toBe(422);
			expect(res.headers.get("HX-Reswap")).toBe("none");
			expect(res.headers.get("HX-Trigger")).toContain('"type":"error"');
			expect(res.headers.get("HX-Trigger")).toContain(
				"This file is over 1 MB.",
			);
			expect(pulled).toBe(false);
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

	describe("the sheet's id is drawn once (#766)", () => {
		// Counts the sheet's own id, which must be on one element in each answer (two would be two elements with one id).
		const sheetIds = (html: string) => html.split('id="sheet"').length - 1;

		it("draws one #sheet on the no-JavaScript page, with the sheet open", async () => {
			const html = await (
				await app.request("/accounts/apple-card", {}, family)
			).text();
			expect(sheetIds(html)).toBe(1);
		});

		it("draws one #sheet in the htmx answer for Upload a file and Add Apple Card", async () => {
			const html = await (
				await app.request(
					"/accounts/apple-card",
					{ headers: { "HX-Request": "true" } },
					family,
				)
			).text();
			expect(sheetIds(html)).toBe(1);
		});

		it("draws one #sheet on the no-JavaScript refusals, the size gate's and a refused file's", async () => {
			const gate = await postUnread("abc");
			expect(sheetIds(gate.html)).toBe(1);
			const refused = await post(
				{ file: file("OFXHEADER:100\n<OFX>"), balance: "" },
				{ htmx: false },
			);
			expect(refused.res.status).toBe(422);
			expect(sheetIds(refused.html)).toBe(1);
		});

		it("draws one #sheet in the htmx 422 that swaps #accounts-summary", async () => {
			const { res, html } = await post(
				{ file: file("OFXHEADER:100\n<OFX>"), balance: "" },
				{ htmx: true },
			);
			expect(res.status).toBe(422);
			expect(sheetIds(html)).toBe(1);
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
			expect(html).toContain(`Updated through ${shortDay(CLEARED_A, TODAY)}`);
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

		it("draws Cancel and the backdrop as links back to /accounts?focus=apple-card, with the attributes htmx swaps Accounts in by", async () => {
			const sheet = (
				await (await app.request("/accounts/apple-card", {}, family)).text()
			).replaceAll("&#39;", "'");
			// Cancel's own link (its text is Cancel) and the backdrop, which closes the sheet the same way.
			const cancel = sheet.match(/<a\b[^>]*>Cancel<\/a>/)?.[0] ?? "";
			const backdrop =
				sheet.match(/<a\b[^>]*data-sheet-close[^>]*>/)?.[0] ?? "";
			expect(cancel).not.toBe("");
			expect(backdrop).not.toBe("");
			for (const link of [cancel, backdrop]) {
				expect(link).toContain('href="/accounts?focus=apple-card"');
				expect(link).toContain('hx-get="/accounts?focus=apple-card"');
				expect(link).toContain('hx-target="#accounts-summary"');
				expect(link).toContain('hx-select="#accounts-summary"');
				expect(link).toContain('hx-swap="outerHTML"');
				expect(link).toContain('hx-push-url="/accounts"');
			}
		});

		it("answers Cancel's htmx request with the cancel toast, and focus back on the Apple Card action", async () => {
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
	/** An upload, sent as a browser's htmx form sends it: the bytes with an explicit Content-Length. */
	async function uploadCsv(text: string, balance = "") {
		const form = new FormData();
		form.set("file", new File([text], "apple.csv", { type: "text/csv" }));
		form.set("balance", balance);
		const request = new Request("http://tally.test/accounts/apple-card", {
			method: "POST",
			body: form,
		});
		const bytes = await request.arrayBuffer();
		return app.request(
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
	}

	it("leaves the first-week record as it was, so an upload draws no stroke", async () => {
		await resetDemo(env.DB, TODAY);
		const before = await readFirstTally(env.DB);
		const res = await uploadCsv(csv(ROW_A), "1,240.18");
		expect(res.status).toBe(200);
		expect(await readFirstTally(env.DB)).toEqual(before);
	});

	it("leaves the first week's waiting count as it was: Apple Card's rows never wait for Jev in it", async () => {
		await resetDemo(env.DB, TODAY);
		// Still in the first week, with a bank's row waiting for Jev's category, so the count the first week reads is not zero.
		expect(isSetUp(await readFirstTally(env.DB))).toBe(false);
		await env.DB.prepare(
			"INSERT INTO transactions (account_id, plaid_transaction_id, date, amount_cents, raw_name) SELECT id, 'first-week-waiting', ?, 1200, 'SHOP WAITING' FROM accounts WHERE plaid_item_id IS NOT NULL ORDER BY id LIMIT 1",
		)
			.bind(TODAY)
			.run();
		const before = (await readGateInputs(env.DB)).waiting;
		expect(before).toBeGreaterThan(0);
		// The upload's rows need a category like any purchase, but they're Apple's, so the first week's count is the same.
		const res = await uploadCsv(csv(ROW_A, ROW_B));
		expect(res.status).toBe(200);
		expect(await cardRows()).toEqual({ n: 2 });
		expect((await readGateInputs(env.DB)).waiting).toBe(before);
	});
});

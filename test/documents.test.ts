import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const BASE = "http://tally.test";
const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");

async function send(path: string, init?: RequestInit) {
	return exports.default.fetch(BASE + path, init);
}

async function upload(file: File, note = "") {
	const data = new FormData();
	data.set("file", file);
	data.set("note", note);
	return send("/documents", {
		method: "POST",
		headers: { Origin: BASE, "HX-Request": "true" },
		body: data,
	});
}

beforeEach(async () => {
	await env.DB.prepare("DELETE FROM documents").run();
	const listed = await env.DOCS.list();
	if (listed.objects.length)
		await env.DOCS.delete(listed.objects.map((o) => o.key));
});

describe("documents", () => {
	it("stores and lists a PDF under a random key", async () => {
		const response = await upload(
			new File([PDF], "statement.pdf", { type: "application/pdf" }),
			"September",
		);
		expect(response.status).toBe(200);
		const row = await env.DB.prepare("SELECT * FROM documents").first<{
			r2_key: string;
		}>();
		expect(row?.r2_key).not.toBe("statement.pdf");
		expect(await env.DOCS.get(row?.r2_key ?? "missing")).not.toBeNull();
		const html = await (await send("/documents")).text();
		expect(html).toContain("statement.pdf");
		expect(html).toContain("September");
	});

	it.each([
		[
			new File(["hello"], "note.txt", { type: "text/plain" }),
			"Choose a PDF file.",
		],
		[
			new File(["hello"], "renamed.pdf", { type: "application/pdf" }),
			"Choose a PDF file.",
		],
		[
			new File([new Uint8Array(11 * 1024 * 1024)], "large.pdf", {
				type: "application/pdf",
			}),
			"Choose a PDF up to 10 MB.",
		],
	])("rejects an invalid upload", async (file, message) => {
		const response = await upload(file);
		const html = await response.text();
		expect(response.status).toBe(422);
		expect(html).toContain('role="alert"');
		expect(html).toContain(message);
	});

	it("downloads bytes with an attachment name and returns 404 for an unknown id", async () => {
		await upload(new File([PDF], 'a "quote".pdf', { type: "application/pdf" }));
		const row = await env.DB.prepare("SELECT id FROM documents").first<{
			id: number;
		}>();
		const response = await send(`/documents/${row?.id}`);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(PDF);
		expect(response.headers.get("Content-Type")).toBe("application/pdf");
		expect(response.headers.get("Content-Disposition")).toContain(
			"attachment;",
		);
		expect(response.headers.get("Content-Disposition")).not.toContain(
			'"quote"',
		);
		expect((await send("/documents/99999")).status).toBe(404);
	});

	it("deletes the row and object, announces it, and rejects a cross-site post", async () => {
		await upload(new File([PDF], "old.pdf", { type: "application/pdf" }));
		const row = await env.DB.prepare("SELECT id, r2_key FROM documents").first<{
			id: number;
			r2_key: string;
		}>();
		const response = await send(`/documents/${row?.id}/delete`, {
			method: "POST",
			headers: { Origin: BASE, "HX-Request": "true" },
		});
		expect(await env.DB.prepare("SELECT id FROM documents").first()).toBeNull();
		expect(await env.DOCS.get(row?.r2_key ?? "missing")).toBeNull();
		expect(JSON.parse(response.headers.get("HX-Trigger") ?? "{}")).toEqual({
			toast: { message: "Deleted old.pdf.", type: "success" },
			announce: "Deleted old.pdf.",
		});
		expect(
			(
				await send(`/documents/${row?.id}/delete`, {
					method: "POST",
					headers: { Origin: "https://evil.test" },
				})
			).status,
		).toBe(403);
	});

	it("renders the add empty state when there are no rows", async () => {
		const html = await (await send("/documents")).text();
		expect(html).toContain("No documents yet.");
		expect(html).toContain("Keep statements and receipts here as PDFs.");
	});
});

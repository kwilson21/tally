import { Hono } from "hono";
import { BottomSheet } from "../views/bottom-sheet";
import { Button } from "../views/button";
import { DocumentRow, type DocumentRowData } from "../views/document-row";
import { EmptyState } from "../views/empty-state";
import { HowLink } from "../views/how-link";
import { Layout } from "../views/layout";

type DocumentRecord = {
	id: number;
	r2_key: string;
	filename: string;
	size_bytes: number;
	uploaded_at: string;
	note: string | null;
};
type App = { Bindings: Env; Variables: { actor: string } };
const MAX_SIZE = 10 * 1024 * 1024;
export const documents = new Hono<App>();

function row(record: DocumentRecord): DocumentRowData {
	return {
		id: record.id,
		filename: record.filename,
		note: record.note,
		sizeBytes: record.size_bytes,
		uploadedAt: record.uploaded_at,
	};
}

async function list(db: D1Database): Promise<DocumentRecord[]> {
	return (
		await db
			.prepare(
				"SELECT id, r2_key, filename, size_bytes, uploaded_at, note FROM documents ORDER BY uploaded_at DESC, id DESC",
			)
			.all<DocumentRecord>()
	).results;
}

function AddButton({ primary = false }: { primary?: boolean }) {
	return (
		<Button
			kind={primary ? "primary" : "secondary"}
			href="/documents/new"
			hx-get="/documents/new"
			hx-target="#page"
			hx-select="#page"
			hx-swap="outerHTML"
		>
			Add a document
		</Button>
	);
}

function Rows({ records }: { records: DocumentRecord[] }) {
	return (
		<div id="documents-list">
			<h2 id="documents-heading" class="sr-only" tabindex={-1}>
				Documents list
			</h2>
			{records.length === 0 ? (
				<EmptyState
					kind="add"
					sentence="No documents yet."
					hint="Keep statements and receipts here as PDFs."
				>
					<AddButton primary />
				</EmptyState>
			) : (
				<ul class="mt-4 divide-y divide-rule border-y border-rule">
					{records.map((record) => (
						<DocumentRow
							document={row(record)}
							action={
								<Button
									kind="text"
									href={`/documents/${record.id}/delete`}
									hx-get={`/documents/${record.id}/delete`}
									hx-target={`#document-${record.id}`}
									hx-swap="outerHTML"
								>
									Delete
								</Button>
							}
						/>
					))}
				</ul>
			)}
		</div>
	);
}

function Page({
	records,
	demo,
	sheet,
}: {
	records: DocumentRecord[];
	demo: boolean;
	sheet?: unknown;
}) {
	return (
		<Layout
			title="Documents · Tally"
			active="documents"
			currentPath="/documents"
			demo={demo}
		>
			<div id="page">
				<h1 class="font-serif text-5xl font-semibold tracking-tight">
					Documents
				</h1>
				<HowLink section={"documents" as "budget"} demo={demo} />
				<p class="mt-2 text-muted">Statements and receipts, as PDFs.</p>
				{records.length > 0 && (
					<div class="mt-3">
						<AddButton />
					</div>
				)}
				<Rows records={records} />
				{sheet as never}
			</div>
		</Layout>
	);
}

function UploadSheet({ error, note = "" }: { error?: string; note?: string }) {
	return (
		<BottomSheet
			labelledBy="upload-title"
			closeHref="/documents"
			closeAttrs={{
				"hx-get": "/documents",
				"hx-target": "#page",
				"hx-select": "#page",
				"hx-swap": "outerHTML",
			}}
		>
			<h2
				id="upload-title"
				class="font-serif text-4xl font-semibold tracking-tight"
			>
				Add a document
			</h2>
			<form
				class="mt-5 flex flex-col gap-4"
				method="post"
				action="/documents"
				enctype="multipart/form-data"
				hx-post="/documents"
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
			>
				<div>
					<label for="document-file" class="block font-semibold">
						PDF file
					</label>
					<input
						id="document-file"
						name="file"
						type="file"
						accept="application/pdf"
						required
						autofocus
						class="mt-1 min-h-11 w-full rounded-control border border-rule bg-paper px-3 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					/>
					<p class="mt-1 text-sm text-muted">Up to 10 MB.</p>
					{error && (
						<p class="mt-1 text-over" role="alert">
							{error}
						</p>
					)}
				</div>
				<div>
					<label for="document-note" class="block font-semibold">
						Note (optional)
					</label>
					<input
						id="document-note"
						name="note"
						value={note}
						maxlength={500}
						class="mt-1 min-h-11 w-full rounded-control border border-rule bg-paper px-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					/>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<Button kind="secondary" href="/documents" class="w-full">
						Cancel
					</Button>
					<Button type="submit" class="w-full" busyLabel="Uploading…">
						Upload
					</Button>
				</div>
			</form>
		</BottomSheet>
	);
}

documents.get("/documents", async (c) =>
	c.html(<Page records={await list(c.env.DB)} demo={c.env.DEMO === "true"} />),
);
documents.get("/documents/new", async (c) =>
	c.html(
		<Page
			records={await list(c.env.DB)}
			demo={c.env.DEMO === "true"}
			sheet={<UploadSheet />}
		/>,
	),
);

documents.post("/documents", async (c) => {
	const data = await c.req.formData();
	const file = data.get("file");
	const note = String(data.get("note") ?? "").trim();
	let error: string | undefined;
	if (!(file instanceof File) || file.type !== "application/pdf")
		error = "Choose a PDF file.";
	else if (file.size > MAX_SIZE) error = "Choose a PDF up to 10 MB.";
	else {
		const signature = new Uint8Array(await file.slice(0, 5).arrayBuffer());
		if (new TextDecoder().decode(signature) !== "%PDF-")
			error = "Choose a PDF file.";
	}
	if (error || !(file instanceof File))
		return c.html(
			<Page
				records={await list(c.env.DB)}
				demo={c.env.DEMO === "true"}
				sheet={<UploadSheet error={error} note={note} />}
			/>,
			422,
		);
	const key = crypto.randomUUID();
	await c.env.DOCS.put(key, file.stream(), {
		httpMetadata: { contentType: "application/pdf" },
	});
	try {
		await c.env.DB.prepare(
			"INSERT INTO documents (r2_key, filename, size_bytes, uploaded_by, uploaded_at, note) VALUES (?, ?, ?, ?, datetime('now'), ?)",
		)
			.bind(key, file.name, file.size, c.get("actor"), note || null)
			.run();
	} catch (cause) {
		await c.env.DOCS.delete(key);
		throw cause;
	}
	if (!c.req.header("HX-Request")) return c.redirect("/documents", 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message: `Uploaded ${file.name}.`, type: "success" },
			announce: `Uploaded ${file.name}.`,
		}),
	);
	return c.html(
		<Page records={await list(c.env.DB)} demo={c.env.DEMO === "true"} />,
	);
});

documents.get("/documents/:id/delete", async (c) => {
	const record = await c.env.DB.prepare(
		"SELECT id, r2_key, filename, size_bytes, uploaded_at, note FROM documents WHERE id=?",
	)
		.bind(c.req.param("id"))
		.first<DocumentRecord>();
	if (!record) return c.notFound();
	return c.html(
		<DocumentRow
			document={row(record)}
			action={
				<span class="flex max-w-56 flex-col items-end gap-1">
					<span>Delete {record.filename}? This can't be undone.</span>
					<span class="flex gap-1">
						<Button kind="secondary" type="submit" form={`delete-${record.id}`}>
							Delete it
						</Button>
						<Button
							kind="text"
							href="/documents"
							hx-get="/documents"
							hx-target="#page"
							hx-select="#page"
							hx-swap="outerHTML"
						>
							Keep
						</Button>
					</span>
					<form
						id={`delete-${record.id}`}
						method="post"
						action={`/documents/${record.id}/delete`}
						hx-post={`/documents/${record.id}/delete`}
						hx-target={`#document-${record.id}`}
						hx-swap="delete"
					/>
				</span>
			}
		/>,
	);
});

documents.post("/documents/:id/delete", async (c) => {
	const record = await c.env.DB.prepare(
		"SELECT id, r2_key, filename FROM documents WHERE id=?",
	)
		.bind(c.req.param("id"))
		.first<Pick<DocumentRecord, "id" | "r2_key" | "filename">>();
	if (!record) return c.notFound();
	await c.env.DB.prepare("DELETE FROM documents WHERE id=?")
		.bind(record.id)
		.run();
	await c.env.DOCS.delete(record.r2_key);
	if (!c.req.header("HX-Request")) return c.redirect("/documents", 303);
	c.header(
		"HX-Trigger",
		JSON.stringify({
			toast: { message: `Deleted ${record.filename}.`, type: "success" },
			announce: `Deleted ${record.filename}.`,
		}),
	);
	c.header("HX-Retarget", "#documents-list");
	c.header("HX-Reswap", "innerHTML");
	return c.html(
		<>
			<h2 id="documents-heading" class="sr-only" tabindex={-1} autofocus>
				Documents list
			</h2>
			{(await list(c.env.DB)).length === 0 && (
				<EmptyState
					kind="add"
					sentence="No documents yet."
					hint="Keep statements and receipts here as PDFs."
				>
					<AddButton primary />
				</EmptyState>
			)}
		</>,
	);
});

documents.get("/documents/:id", async (c) => {
	const record = await c.env.DB.prepare(
		"SELECT r2_key, filename FROM documents WHERE id=?",
	)
		.bind(c.req.param("id"))
		.first<Pick<DocumentRecord, "r2_key" | "filename">>();
	if (!record) return c.notFound();
	const object = await c.env.DOCS.get(record.r2_key);
	if (!object || !("body" in object)) return c.notFound();
	const safe = record.filename.replace(/["\\\r\n]/g, "_");
	return new Response(object.body, {
		headers: {
			"Content-Type": "application/pdf",
			"Content-Disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(record.filename)}`,
			"Content-Length": String(object.size),
		},
	});
});

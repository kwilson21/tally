import type { Child } from "hono/jsx";

export type DocumentRowData = {
	id: number;
	filename: string;
	note: string | null;
	sizeBytes: number;
	uploadedAt: string;
};

function size(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${Math.round(bytes / 1024)} KB`;
}

function date(value: string): string {
	const [year = 1970, month = 1, day = 1] = value
		.slice(0, 10)
		.split("-")
		.map(Number);
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	}).format(new Date(Date.UTC(year, month - 1, day)));
}

/** One stored PDF: its download, optional note, metadata, and action. */
export function DocumentRow({
	document,
	action,
}: {
	document: DocumentRowData;
	action?: Child;
}) {
	return (
		<li
			id={`document-${document.id}`}
			class="flex min-h-16 items-center gap-3 py-2"
		>
			<span class="min-w-0 flex-1">
				<a
					href={`/documents/${document.id}`}
					class="block truncate text-lg leading-6"
				>
					{document.filename}
				</a>
				{document.note && <span class="block leading-6">{document.note}</span>}
				<span class="block leading-6 text-muted">
					Added {date(document.uploadedAt)} · {size(document.sizeBytes)}
				</span>
			</span>
			{action}
		</li>
	);
}

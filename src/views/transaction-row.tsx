import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { CategoryIcon } from "./category";
import { Icon } from "./icons";

type Caption = {
	kind: "category" | "income" | "excluded" | "needs";
	caption: string | null;
	tag: boolean;
};

/** What a row says under its name, and which icon it gets. Status is always in words, never color alone. */
export function rowCaption(row: ListRow): Caption {
	if (row.excluded)
		return { kind: "excluded", caption: "Excluded", tag: false };
	if (row.parentId)
		return {
			kind: "category",
			caption: `${row.categoryName ? `${row.categoryName} · ` : ""}Split from ${row.parentName ?? tidyFallback(row.rawName)}`,
			tag: false,
		};
	if (row.isSplit)
		return { kind: "category", caption: "Split transaction", tag: false };
	// The note stays only until the purchase has a category again.
	if (
		row.splitRemovedFromCents !== null &&
		row.splitRemovedFromCents !== undefined &&
		row.categoryId === null
	)
		return {
			kind: "needs",
			caption: `The bank changed this from ${formatCents(row.splitRemovedFromCents, { signed: true })}, so its split was removed.`,
			tag: true,
		};
	if (row.income) return { kind: "income", caption: "Income", tag: false };
	if (row.categoryName)
		return { kind: "category", caption: row.categoryName, tag: false };
	return {
		kind: "needs",
		caption: row.rawName === row.displayName ? null : row.rawName,
		tag: true,
	};
}

const tidyFallback = (name: string) =>
	name.toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());

function RowIcon({ row, kind }: { row: ListRow; kind: Caption["kind"] }) {
	if (kind === "category")
		return (
			<CategoryIcon
				icon={row.categoryIcon ?? ""}
				color={row.categoryColor ?? ""}
			/>
		);
	const [name, tone] =
		kind === "income"
			? (["income", "text-ink"] as const)
			: kind === "excluded"
				? (["transfer", "text-muted"] as const)
				: (["circle-dashed", "text-muted"] as const);
	return (
		<span class={`shrink-0 ${tone}`}>
			<Icon name={name} class="size-7" />
		</span>
	);
}

/** One transaction. With `href` the whole row is one link (to its edit panel); without, it's a plain row. */
export function TransactionRow({
	row,
	href,
	attrs,
	autofocus,
	bare = false,
}: {
	row: ListRow;
	href?: string;
	/** Extra attributes for the link (htmx). */
	attrs?: Record<string, string>;
	/** Move focus here after a swap (the row just saved). */
	autofocus?: boolean;
	/** Leave out the list item when another interactive row owns the wrapper. */
	bare?: boolean;
}) {
	const { kind, caption, tag } = rowCaption(row);
	const Row = href ? "a" : "div";
	const content = (
		<>
			{/* Every row is the same height: two lines (name, then caption and tag), long text truncated. */}
			<Row
				href={href}
				autofocus={autofocus}
				class="flex h-16 items-center gap-4 text-ink no-underline"
				{...attrs}
			>
				<RowIcon row={row} kind={kind} />
				<span class="min-w-0 flex-1">
					<span
						class={`block truncate text-lg leading-6 ${kind === "excluded" ? "text-muted" : ""}`}
					>
						{row.displayName}
					</span>
					<span class="flex min-w-0 items-center gap-2 leading-6">
						{caption && <span class="truncate text-muted">{caption}</span>}
						{row.countsInMonth && (
							<span class="shrink-0 text-muted">
								{caption && "· "}Counts in{" "}
								{new Intl.DateTimeFormat("en-US", {
									month: "long",
									timeZone: "UTC",
								}).format(new Date(`${row.countsInMonth}-01T00:00:00Z`))}
							</span>
						)}
						{tag && (
							<span class="shrink-0 rounded-control bg-band px-2 text-sm text-ink">
								Needs category
							</span>
						)}
					</span>
				</span>
				<span class="shrink-0 text-lg">
					{formatCents(row.amountCents, { signed: true })}
				</span>
			</Row>
		</>
	);
	return bare ? content : <li data-transaction={row.id}>{content}</li>;
}

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
	if (row.income) return { kind: "income", caption: "Income", tag: false };
	if (row.categoryName)
		return { kind: "category", caption: row.categoryName, tag: false };
	return {
		kind: "needs",
		caption: row.rawName === row.displayName ? null : row.rawName,
		tag: true,
	};
}

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
}: {
	row: ListRow;
	href?: string;
	/** Extra attributes for the link (htmx). */
	attrs?: Record<string, string>;
	/** Move focus here after a swap (the row just saved). */
	autofocus?: boolean;
}) {
	const { kind, caption, tag } = rowCaption(row);
	const Row = href ? "a" : "div";
	return (
		<li data-transaction={row.id}>
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
		</li>
	);
}

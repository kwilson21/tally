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

/** One transaction: a single link to its edit URL, keeping the list's filters. */
export function TransactionRow({
	row,
	query,
}: {
	row: ListRow;
	query: string;
}) {
	const { kind, caption, tag } = rowCaption(row);
	const href = `/transactions/${row.id}${query ? `?${query}` : ""}`;
	return (
		<li>
			<a
				href={href}
				class="flex min-h-11 items-start gap-4 py-3 text-ink no-underline"
			>
				<RowIcon row={row} kind={kind} />
				<span class="min-w-0 flex-1">
					<span
						class={`block truncate text-lg ${kind === "excluded" ? "text-muted" : ""}`}
					>
						{row.displayName}
					</span>
					{caption && <span class="block truncate text-muted">{caption}</span>}
					{tag && (
						<span class="mt-1 inline-block rounded-control bg-band px-2 text-sm text-ink">
							Needs category
						</span>
					)}
				</span>
				<span class="text-lg">
					{formatCents(row.amountCents, { signed: true })}
				</span>
			</a>
		</li>
	);
}

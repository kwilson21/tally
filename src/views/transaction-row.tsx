import { unpaidBillsNote } from "../bills/unpaid";
import { shortDay } from "../dates";
import type { ListRow } from "../db/transactions";
import { formatCents } from "../money";
import { CategoryIcon } from "./category";
import { Icon, ROW_OPENS, RowArrow } from "./icons";
import {
	MaybeCategory,
	MaybeIncome,
	maybeIncomeVisible,
} from "./maybe-category";
import { BankMark, GuessMark, SUGGESTED_NAME_CLASS } from "./name-choices";

type Caption = {
	kind: "category" | "income" | "excluded" | "needs";
	caption: string | null;
	tag: boolean;
};

/** What a row says under its name, and which icon it gets. Status is always in words, never color alone. */
export function rowCaption(row: ListRow): Caption {
	const paidBillName = row.parentId
		? (row.billName ?? row.parentBillName)
		: row.billName;
	const paidBill =
		row.paysBill && paidBillName ? `paid ${paidBillName} bill` : null;
	// A refund the bank's change unlinked says why, with the purchase's date, until a person links it again (decision 99).
	const unlinked = row.refundUnlinkedPurchaseDate
		? `The bank changed the ${shortDay(row.refundUnlinkedPurchaseDate, row.date)} purchase, so this refund is no longer linked`
		: null;
	// A payment linked to a bill counts, so it isn't called excluded (spec §8.5); it reads as what it is.
	if (row.excluded && !row.paysBill)
		return { kind: "excluded", caption: "Excluded", tag: false };
	if (maybeIncomeVisible(row))
		return { kind: "needs", caption: "Maybe income", tag: false };
	if (
		!row.followsPurchase &&
		!row.creditReviewed &&
		row.amountCents < 0 &&
		!row.income
	)
		return { kind: "needs", caption: "Review credit", tag: false };
	if (row.parentId)
		return {
			kind: "category",
			caption: [
				row.categoryName,
				`Split from ${row.parentName ?? tidyFallback(row.rawName)}`,
				unlinked,
				refunded(row),
				paidBill,
			]
				.filter(Boolean)
				.join(" · "),
			tag: false,
		};
	if (row.isSplit)
		return {
			kind: "category",
			caption: ["Split transaction", paidBill].filter(Boolean).join(" · "),
			tag: false,
		};
	// An income row says only Income, even when a bank change removed its split; its restored category and note stay in the edit panel.
	if (row.income) return { kind: "income", caption: "Income", tag: false };
	// The note stays on the purchase until a person changes or confirms its category (decision 99), so it
	// is shown beside the category it went back to, or in Needs category when it has none.
	if (
		row.splitRemovedFromCents !== null &&
		row.splitRemovedFromCents !== undefined
	) {
		const note = `The bank changed this from ${formatCents(row.splitRemovedFromCents, { signed: true })}, so its split was removed.${unpaidBillsNote(row.splitRemovedBills)}`;
		// The refunds and the bill follow the note, in the same order as a categorized row (#313, #382).
		const facts = [note, refunded(row), paidBill];
		return row.categoryId === null
			? {
					kind: "needs",
					caption: facts.filter(Boolean).join(" · "),
					tag: true,
				}
			: {
					kind: "category",
					caption: [row.categoryName, ...facts].filter(Boolean).join(" · "),
					tag: false,
				};
	}
	// A linked refund and its purchase each say so after the category (P19). A refund the bank's change
	// unlinked says why instead (decision 99).
	const pair =
		unlinked ??
		(row.refundPurchaseDate
			? `Refund for ${shortDay(row.refundPurchaseDate, row.date)}`
			: refunded(row));
	if (row.categoryName)
		return {
			kind: "category",
			caption: [row.categoryName, pair, paidBill].filter(Boolean).join(" · "),
			tag: false,
		};
	// A refund and the bill it paid both say so ahead of the note, in the same order as a categorized row (#313).
	const facts = [pair, paidBill].filter(Boolean).join(" · ") || null;
	// A refund that follows its purchase takes its category, so the tag sits on the purchase's row.
	if (row.followsPurchase) return { kind: "needs", caption: facts, tag: false };
	return {
		kind: "needs",
		caption:
			facts ||
			row.note ||
			(row.rawName === row.displayName ? null : row.rawName),
		tag: true,
	};
}

/** "$24.99 refunded" when refunds are linked to this purchase. */
const refunded = (row: ListRow) =>
	row.refundedCents ? `${formatCents(row.refundedCents)} refunded` : null;

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
	bankText = true,
}: {
	row: ListRow;
	href?: string;
	/** Extra attributes for the link (htmx). */
	attrs?: Record<string, string>;
	/** Move focus here after a swap (the row just saved). */
	autofocus?: boolean;
	/** Leave out the list item when another interactive row owns the wrapper. */
	bare?: boolean;
	/** Show the bank's text under a row that needs a category; off where the text is already struck above it (Start here). */
	bankText?: boolean;
}) {
	const { kind, caption: said, tag } = rowCaption(row);
	// A bank change's sentence keeps its place on the row over a Maybe category; the edit panel still shows the suggestion.
	const bankChangeSaid =
		Boolean(row.refundUnlinkedPurchaseDate) ||
		row.splitRemovedFromCents != null;
	const maybeCategoryName = bankChangeSaid ? null : row.maybeCategoryName;
	const maybeCategory =
		kind === "needs" && tag && maybeCategoryName?.startsWith("new:")
			? { name: maybeCategoryName.slice(4), kind: "new" as const }
			: kind === "needs" && tag && maybeCategoryName
				? { name: maybeCategoryName, kind: "category" as const }
				: null;
	// Needs category is said in words, in place of the pill (P118 A); a Maybe guess keeps its dashed tag instead.
	const needsWords = tag && !maybeCategory;
	// "Counts in …" shows when a bill moved the month, except where a refund's caption already names it.
	const countsIn =
		row.countsInMonth &&
		row.countsInMonth !== row.refundPurchaseDate?.slice(0, 7)
			? row.countsInMonth
			: null;
	// Pending (P34 A, decision 72) joins the one caption line in muted words, never cut off. On a row that
	// needs a category it takes the bank text's place; after a lone category or Income it reads
	// "Groceries · Pending"; when the caption already says more (Excluded, Split from…, Refund for…,
	// Counts in…) it goes first, so it is always the first thing read.
	const pending = row.pending === true;
	const caption =
		(pending || !bankText) && kind === "needs" && tag && said === row.rawName
			? null
			: said;
	const guessedNoteShown = Boolean(
		row.noteGuessed && kind === "needs" && caption === row.note,
	);
	const pendingLast =
		pending &&
		!countsIn &&
		(kind === "income" ||
			(kind === "category" && caption === row.categoryName));
	const pendingFirst = pending && !pendingLast;
	const Row = href ? "a" : "div";
	const content = (
		<>
			{/* Every row is the same height: two lines (name, then caption and tag), long text truncated. */}
			<Row
				href={href}
				autofocus={autofocus}
				class={`flex h-16 items-center gap-4 text-ink no-underline${href ? ` ${ROW_OPENS}` : ""}`}
				{...attrs}
			>
				<RowIcon row={row} kind={kind} />
				<span class="min-w-0 flex-1">
					{row.nameSuggested ? (
						// A name Tally guessed has the sparkles icon before it; a name the bank sent has none. Both have the dashed
						// underline that says "not decided yet" (P29 A, P87 B, decisions 64 and 80). The marks are for the eye; the words are for a screen reader.
						<span
							class={`flex min-w-0 items-center gap-2 text-lg leading-6 ${kind === "excluded" ? "text-muted" : ""}`}
						>
							{row.nameFromBank ? <BankMark /> : <GuessMark />}
							<span class={`truncate ${SUGGESTED_NAME_CLASS}`}>
								{row.displayName}
							</span>
						</span>
					) : (
						<span
							class={`block truncate text-lg leading-6 ${kind === "excluded" ? "text-muted" : ""}`}
						>
							{row.displayName}
						</span>
					)}
					<span class="flex min-w-0 items-center gap-2 leading-6">
						{pendingFirst && !needsWords && (
							<span class="shrink-0 text-muted">
								Pending{(caption || countsIn) && " ·"}
							</span>
						)}
						{maybeIncomeVisible(row) ? (
							<MaybeIncome />
						) : maybeCategory ? (
							<MaybeCategory
								name={maybeCategory.name}
								kind={maybeCategory.kind}
							/>
						) : needsWords ? (
							<span class="flex min-w-0">
								{/* The words never shrink; the dot's spaces are no-break, so the space after it is never lost. */}
								<span class="shrink-0 text-muted">
									{pendingFirst && "Pending · "}Needs category
									{caption && "\u00a0·\u00a0"}
								</span>
								{caption && (
									<span
										class={`truncate text-muted ${guessedNoteShown ? SUGGESTED_NAME_CLASS : ""}`}
									>
										{guessedNoteShown && (
											<span class="sr-only">Tally's guess: </span>
										)}
										{caption}
									</span>
								)}
							</span>
						) : (
							caption && (
								<span
									class={`truncate text-muted ${guessedNoteShown ? SUGGESTED_NAME_CLASS : ""}`}
								>
									{guessedNoteShown && (
										<span class="sr-only">Tally's guess: </span>
									)}
									{caption}
								</span>
							)
						)}
						{/* A linked refund's caption names its purchase; the month shows only when a bill moved it. */}
						{countsIn && (
							<span class="shrink-0 text-muted">
								{(caption || needsWords) && "· "}Counts in{" "}
								{new Intl.DateTimeFormat("en-US", {
									month: "long",
									timeZone: "UTC",
								}).format(new Date(`${countsIn}-01T00:00:00Z`))}
							</span>
						)}
						{pendingLast && <span class="shrink-0 text-muted">· Pending</span>}
					</span>
				</span>
				<span class="shrink-0 text-lg">
					{formatCents(row.amountCents, { signed: true })}
				</span>
				{href && <RowArrow />}
			</Row>
		</>
	);
	return bare ? content : <li data-transaction={row.id}>{content}</li>;
}

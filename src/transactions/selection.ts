// What Select mode's bar selects (#321): the rows ticked, or, in "all" mode, every selectable row the filters
// match except the ones unticked after Select all (decision 80). Pure: the rows come from the database.

/** What a request carries about the selection: its ticks, and in "all" mode the rows unticked from the set. */
export type Selection = {
	/** Ticked rows, each once. In "all" mode, only those the filters don't match: the set holds the rest. */
	ticks: number[];
	/** Every selectable row the filters match is selected, except `unticked` (decision 80). */
	all: boolean;
	/** Rows unticked from the whole set. Empty unless `all`. */
	unticked: number[];
};

export const NO_SELECTION: Selection = { ticks: [], all: false, unticked: [] };

/**
 * The rows unticked from the set, read from the page's boxes: a row on the page is unticked when its box is not
 * checked (`pageIds` minus `checked`), and `hidden` keeps the rows that were off the page. Without `pageIds`
 * (a request that drew no page) `hidden` stands. A checked row is never unticked.
 */
export function unticksFrom(
	hidden: number[],
	checked: number[],
	pageIds?: number[],
): number[] {
	const ticked = new Set(checked);
	const onPage = new Set(pageIds);
	const kept = hidden.filter((id) => !onPage.has(id));
	const unticked = (pageIds ?? []).filter((id) => !ticked.has(id));
	return [...new Set([...kept, ...unticked])].filter((id) => !ticked.has(id));
}

/**
 * The selection once the rows the filters match are known. In "all" mode a tick on a matched row is already
 * selected by the set, so it is dropped from the ticks; the unticked rows stay. Idempotent.
 */
export function settle(
	selection: Selection,
	matched: ReadonlySet<number>,
): Selection {
	if (!selection.all)
		return { ticks: selection.ticks, all: false, unticked: [] };
	return {
		ticks: selection.ticks.filter((id) => !matched.has(id)),
		all: true,
		unticked: selection.unticked,
	};
}

/** The rows a settled selection acts on: in "all" mode the matches less the unticked rows, then the ticks. */
export function selectedIds(
	selection: Selection,
	matched: readonly number[],
): number[] {
	if (!selection.all) return selection.ticks;
	const off = new Set(selection.unticked);
	return [...matched.filter((id) => !off.has(id)), ...selection.ticks];
}

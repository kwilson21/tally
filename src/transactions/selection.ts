// What Select mode's bar selects (#321): the rows ticked, or, in "all" mode, every selectable row the filters
// match except the ones unticked after Select all (decision 80). Pure: the rows come from the database.

/** What a request carries about the selection: its ticks, and in "all" mode the rows unticked from the set. */
export type Selection = {
	/** Ticked rows, each once. In "all" mode, only those the filters don't match: the set holds the rest. */
	ticks: number[];
	/**
	 * Ticks the whole set also holds, each once: kept so a tick outlives a filter change (#350). Empty once settled
	 * outside "all" mode, where they fold into `ticks`.
	 */
	held: number[];
	/** Every selectable row the filters match is selected, except `unticked` (decision 80). */
	all: boolean;
	/** Rows unticked from the whole set. Empty unless `all`. */
	unticked: number[];
};

export const NO_SELECTION: Selection = {
	ticks: [],
	held: [],
	all: false,
	unticked: [],
};

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
 * The ticks a request posts (#321): every posted id, except in "all" mode the ids the page drew. There a checked
 * box is a row the set holds, so only its unchecked state counts (unticksFrom), and the set follows the filters
 * the request names. Without `pageIds` (a form that drew no page) every posted id is a tick.
 */
export function ticksFrom(
	checked: number[],
	all: boolean,
	pageIds?: number[],
): number[] {
	if (!all || pageIds === undefined) return checked;
	const onPage = new Set(pageIds);
	return checked.filter((id) => !onPage.has(id));
}

/**
 * The selection once the rows the filters match are known. In "all" mode a tick on a matched row is held by the
 * set (`held`), a held row the filters no longer match is a tick again, and a row unticked from the set is in
 * neither (unticking ends a tick). Outside "all" mode held folds into the ticks. Idempotent.
 */
export function settle(
	selection: Selection,
	matched: ReadonlySet<number>,
): Selection {
	const everyTick = [...selection.ticks, ...selection.held];
	if (!selection.all)
		return {
			ticks: unique(everyTick),
			held: [],
			all: false,
			unticked: [],
		};
	const off = new Set(selection.unticked);
	const keep = (id: number) => !off.has(id);
	return {
		ticks: unique(everyTick.filter((id) => !matched.has(id) && keep(id))),
		held: unique(everyTick.filter((id) => matched.has(id) && keep(id))),
		all: true,
		unticked: selection.unticked,
	};
}

/** Each id once, in the order first given. */
export function unique(ids: number[]): number[] {
	return [...new Set(ids)];
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

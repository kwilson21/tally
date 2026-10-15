import type { Child } from "hono/jsx";

/**
 * The pencil tick (P119 A, decision 111, #71). After a save, the saved row's arrow gives way to it for as long as the
 * toast stays, drawn in 150 ms (CSS only, in app.css). Its outline is the drawing's, a filled tapered mark, so it
 * is drawn with the same clip the proposals page uses. Hidden from assistive technology: the toast and the
 * announcer say what changed.
 */
export const TICK_PATH =
	"M3.59 13.65L8.98 18.66L19.88 5.53L19.12 4.87L8.93 16.27L5.41 11.95Z";

/**
 * How a save's own reply marks its row (P119 A): `toast` for the toast's four seconds, `undo` when its toast offers
 * Undo (ten seconds), and `held` for the catalog's still picture of a saved row at the tick's full draw.
 */
export type SavedMark = "toast" | "undo" | "held";

/** The class a saved row gets, or none. CSS keeps the tick for the toast's stay (app.css, "saved row"). */
export function savedRowClass(saved?: SavedMark): string {
	if (saved === undefined) return "";
	if (saved === "toast") return "row-saved";
	return saved === "undo" ? "row-saved-undo" : "row-saved-held";
}

/**
 * The mark a list row gets from a save (P119 A, #71): the saved row gets `mark` (the toast's stay, or the Undo
 * toast's ten seconds), and no other row does. Every list passes it, so a row's mark is only ever the save's.
 */
export function listRowMark(
	rowId: number,
	savedId?: number,
	mark: "toast" | "undo" = "toast",
): SavedMark | undefined {
	return rowId === savedId ? mark : undefined;
}

/**
 * The tick, in a 20px box: the arrow's own size, so it takes the arrow's place. It sits in the same grid cell as the
 * arrow (SavedSlot), which CSS shows and hides by the row's class.
 */
export function SavedTick() {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
			class="saved-tick col-start-1 row-start-1 size-5 -rotate-[8deg] text-ink"
		>
			<path fill="currentColor" d={TICK_PATH} />
		</svg>
	);
}

/**
 * A saved row's arrow slot: the arrow and the tick share one grid cell, so the tick takes the arrow's place with no
 * shift. The arrow's own wrapper (`saved-arrow`) is what CSS hides for the toast's stay and brings back after it.
 * `class` takes the box the arrow would have (its size and margins, and the placement a row gives it).
 */
export function SavedSlot({
	class: extra,
	children,
}: {
	class?: string;
	children: Child;
}) {
	return (
		<span class={extra ? `grid ${extra}` : "grid"}>
			<span class="saved-arrow col-start-1 row-start-1 flex">{children}</span>
			<SavedTick />
		</span>
	);
}

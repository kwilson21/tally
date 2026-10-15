import type { Child } from "hono/jsx";
import { BottomSheet } from "./bottom-sheet";
import { Icon } from "./icons";
import { SheetCancel } from "./sheet-footer";

// The keys (#72, decisions 109 and 118): the key chip, the ledger that lists them, the details that show it without
// the script, and the sheet that keyboard.js opens with ?. Every key is drawn here, so the catalog can't drift.

/** One key, as a chip: its name in the monospaced key face, centred in a box with a rule. */
export function Key({ children }: { children?: Child }) {
	return (
		<kbd class="inline-flex min-h-6 min-w-6 items-center justify-center rounded-control border border-rule px-1.5 font-mono text-sm">
			{children}
		</kbd>
	);
}

type Row = {
	keys: string[];
	/** How several keys join: "/" for "j / k", "or" for "e or Enter". */
	joined?: "/" | "or";
	words: string;
};

// The ledger, in the order a person meets the keys. Decision 118 adds Enter, the arrows and u to decision 109's list.
const LEDGER: { heading: string; rows: Row[] }[] = [
	{
		heading: "Anywhere",
		rows: [
			{ keys: ["/"], words: "Search transactions" },
			{ keys: ["?"], words: "Show these keys" },
		],
	},
	{
		heading: "In a list",
		rows: [
			{ keys: ["j", "k"], joined: "/", words: "Next row / previous row" },
			{ keys: ["e", "Enter"], joined: "or", words: "Open the row" },
		],
	},
	{
		heading: "On Home",
		rows: [
			{ keys: ["←", "→"], joined: "/", words: "Previous month / next month" },
		],
	},
	{
		heading: "After a change",
		rows: [{ keys: ["u"], words: "Undo it, while its toast shows" }],
	},
];

function RowKeys({ row }: { row: Row }) {
	return (
		<span class="flex shrink-0 items-center gap-1">
			{row.keys.map((key, index) => (
				<>
					{index > 0 && (
						<span class="text-sm text-muted">
							{row.joined === "or" ? "or" : "/"}
						</span>
					)}
					<Key>{key}</Key>
				</>
			))}
		</span>
	);
}

/** The ledger of keys: the same list the sheet, the foot's details and More's row all show. */
export function Ledger() {
	return (
		<div class="flex flex-col gap-3">
			{LEDGER.map((section) => (
				<div>
					<p class="text-sm font-medium text-muted">{section.heading}</p>
					<ul class="mt-1 divide-y divide-rule border-y border-rule">
						{section.rows.map((row) => (
							<li class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
								<RowKeys row={row} />
								<span class="text-sm">{row.words}</span>
							</li>
						))}
					</ul>
				</div>
			))}
			<p class="text-sm text-muted">
				Keys don't work while you're typing in a field. In a sheet, Escape
				closes it.
			</p>
		</div>
	);
}

/**
 * The keys' details, closed by default, with the ledger inside it, so the list reads without the script. On desktop it
 * sits at the foot of a page under How this works (HowFoot). `row` is More's last row below lg, with the keyboard icon
 * first and the chevron at the far right. `open` is for drawings only.
 */
export function KeysDetails({
	open = false,
	row = false,
}: {
	open?: boolean;
	row?: boolean;
}) {
	const turn = (
		<span class="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none">
			<Icon name="chevron-right" class="size-5" />
		</span>
	);
	const layout = row
		? "grid min-h-16 grid-cols-[1.5rem_1fr_auto] items-center gap-x-4 py-3"
		: "flex min-h-11 items-center gap-2";
	return (
		<details class="group" open={open}>
			<summary
				class={`${layout} cursor-pointer list-none text-lg text-ink [&::-webkit-details-marker]:hidden`}
			>
				{row ? <Icon name="keyboard" class="size-6" /> : turn}
				Keyboard shortcuts
				{row && turn}
			</summary>
			<div class={row ? "pb-3" : "mt-3"}>
				<Ledger />
			</div>
		</details>
	);
}

/** The keys sheet's body: its title, in the ledger-sheet title role, and the ledger. The sheet's frame is BottomSheet's. */
export function KeysSheetBody() {
	return (
		<>
			<h2
				id="keys-title"
				class="font-serif text-2xl font-semibold tracking-tight"
			>
				Keyboard shortcuts
			</h2>
			<div class="mt-4">
				<Ledger />
			</div>
		</>
	);
}

/**
 * The keys sheet (decision 118, P128 C): the ledger in a BottomSheet over the page it was opened from, which is what
 * `?keys` in the address draws. Cancel and the backdrop close to `closeHref`, the same page without keys, swapping
 * #keys back empty, so the list keeps its place.
 */
export function KeysSheet({ closeHref }: { closeHref: string }) {
	const closeAttrs = {
		"hx-get": closeHref,
		"hx-target": "#keys",
		"hx-select": "#keys",
		"hx-swap": "outerHTML",
		"hx-push-url": "true",
	};
	return (
		<BottomSheet
			labelledBy="keys-title"
			closeHref={closeHref}
			closeAttrs={closeAttrs}
			footer={<SheetCancel href={closeHref} attrs={closeAttrs} />}
		>
			<KeysSheetBody />
		</BottomSheet>
	);
}

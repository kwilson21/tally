// P144 (#865): the sorting turn's picture with the context the owner asked for. The picture and its arrow sentences
// stay as the catalog draws them (CURRENT); PROPOSED adds what the machine is for and a table of how a state is read
// from what is stored. Both pictures are MachineDiagram of the real machine, so they can't drift from it. Open: the owner picks.

import type { Child } from "hono/jsx";
import {
	SORTING_TURN_LABELS,
	sortingTurnMachine,
} from "../machines/sorting-turn";
import { MachineDiagram } from "../views/machine-diagram";

const TITLE = "How the sorting turn is held and given back";

/** A code name, in the mono face. */
const Code = ({ children }: { children: string }) => (
	<code class="font-mono text-sm">{children}</code>
);

/** One state's row in the table: the state's label, then what stored fact decides it. */
function StateRow({ label, children }: { label: string; children?: Child }) {
	return (
		<tr class="border-t border-rule align-top">
			<th scope="row" class="py-3 pr-4 text-left font-semibold">
				{label}
			</th>
			<td class="py-3 break-words">{children}</td>
		</tr>
	);
}

export function MachineContextProposal() {
	return (
		<div class="mt-6 flex flex-col gap-10">
			<div class="flex flex-col gap-3">
				<h3 class="font-serif text-2xl font-semibold">
					Current: the picture as the catalog shows it
				</h3>
				<p class="max-w-prose text-muted">
					The picture and its arrow sentences as they are on the catalog's
					MachineDiagram row now. Nothing here is changed.
				</p>
				<MachineDiagram
					id="p144-current"
					title={TITLE}
					machine={sortingTurnMachine}
					labels={SORTING_TURN_LABELS}
				/>
			</div>

			<div class="flex flex-col gap-3">
				<h3 class="font-serif text-2xl font-semibold">
					Proposed: the picture with its table
				</h3>
				<p class="max-w-prose text-muted">
					The sorting turn's picture with one table beside it.
				</p>
				<p class="max-w-prose">
					<span class="font-semibold">What it is for.</span> One sorting group
					at a time may ask Jev about the household's transactions, so two runs
					never ask about the same one.
				</p>
				<MachineDiagram
					id="p144-proposed"
					title={TITLE}
					machine={sortingTurnMachine}
					labels={SORTING_TURN_LABELS}
				/>

				<table class="mt-2 w-full border-collapse text-sm">
					<caption class="mb-2 text-left font-serif text-xl font-semibold">
						How Tally tells which state it is in
					</caption>
					<thead>
						<tr class="align-bottom">
							<th scope="col" class="pb-2 pr-4 text-left font-semibold">
								State
							</th>
							<th scope="col" class="pb-2 text-left font-semibold">
								What decides it, as stored
							</th>
						</tr>
					</thead>
					<tbody>
						<StateRow label="Free">
							No <Code>sorting_turn</Code> row in{" "}
							<Code>household_settings</Code>. A release deletes the row. A
							damaged row (its <Code>value</Code> is not an object with a text{" "}
							<Code>id</Code> and a numeric or missing <Code>until</Code>)
							counts as no row.
						</StateRow>
						<StateRow label="Held">
							The row's <Code>value</Code> names the holding group's{" "}
							<Code>id</Code>, and its <Code>until</Code> is still ahead of the
							clock. Taking the turn writes <Code>until</Code> 15 minutes on.
						</StateRow>
						<StateRow label="Ran out">
							The same row, with an <Code>until</Code> in the past or none.
							Nothing is written when a turn runs out: a reader compares{" "}
							<Code>until</Code> with the clock.
						</StateRow>
					</tbody>
				</table>
			</div>
		</div>
	);
}

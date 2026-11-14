// P144 (#865): the sorting turn's picture with the context the owner asked for. The picture and its arrow sentences
// stay as the catalog draws them (CURRENT); PROPOSED (C) adds what the machine is for, how a state is read from what
// is stored, where the rule lives, the machine's `free` state verbatim, and one turn walked through the picture.
// Both pictures are MachineDiagram of the real machine, so they can't drift from it. Open: the owner picks.

import type { Child } from "hono/jsx";
import {
	SORTING_TURN_LABELS,
	sortingTurnMachine,
} from "../machines/sorting-turn";
import { MachineDiagram } from "../views/machine-diagram";

const TITLE = "How the sorting turn is held and given back";

/**
 * The machine's `free` state, verbatim: lines 30 to 42 of src/machines/sorting-turn.ts, with its real tabs. The test
 * reads that file and fails if this text is no longer a substring of it, so the excerpt can't drift from the rule.
 */
export const SORTING_TURN_EXCERPT = [
	"\t\tfree: {",
	'\t\t\tdescription: "Nobody has the turn",',
	"\t\t\ton: {",
	"\t\t\t\tTAKE: {",
	'\t\t\t\t\ttarget: "held",',
	'\t\t\t\t\tdescription: "A group takes the free turn",',
	"\t\t\t\t},",
	"\t\t\t\tRETAKE: {",
	'\t\t\t\t\ttarget: "held",',
	'\t\t\t\t\tdescription: "A group takes the turn it had given back or lost",',
	"\t\t\t\t},",
	"\t\t\t},",
	"\t\t},",
].join("\n");

/** A code name, in the mono face (the proposed type role for code, see the caption above the excerpt). */
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
					Proposed (C): the picture with its context
				</h3>
				<p class="max-w-prose text-muted">
					C is the fullest version: its purpose, the picture, the state table,
					the rule's location, the code and one turn walked through. A is C
					without the code and the story; B is C without the story. Ask for
					either lighter one.
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

				<p class="max-w-prose">
					<span class="font-semibold">Where the rule lives.</span>{" "}
					<Code>src/machines/sorting-turn.ts</Code> (the states and events),{" "}
					<Code>src/db/sorting-turn.ts</Code> (the statements that write them)
					and <Code>test/sorting-turn-machine.test.ts</Code> (every state
					against every event). Decisions 139 and 143, as the files cite them.
				</p>
			</div>

			<div class="flex flex-col gap-3">
				<h3 class="font-serif text-2xl font-semibold">In the code</h3>
				<p class="max-w-prose text-muted">
					Proposed: a code block in the mono face (<Code>--font-mono</Code>,
					which a Key chip uses today). The machine's <Code>free</Code> state,
					where it holds TAKE and RETAKE, is{" "}
					<Code>src/machines/sorting-turn.ts</Code> lines 30 to 42. The{" "}
					<Code>held</Code> state is longer and is left out; the save's SQL is
					left out because it is JavaScript template text with its interpolated
					calls spliced in, not SQL a reader can follow.
				</p>
				{/* A section with a name is a region, and its arrow keys scroll it, so it takes focus (as month-end's row does). */}
				<section
					tabindex={0}
					aria-label="src/machines/sorting-turn.ts, lines 30 to 42"
					class="max-w-full overflow-x-auto rounded-control border border-rule bg-band p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				>
					<pre class="m-0 font-mono text-sm tab-2">{SORTING_TURN_EXCERPT}</pre>
				</section>
			</div>

			<div class="flex flex-col gap-3">
				<h3 class="font-serif text-2xl font-semibold">
					One turn, step by step
				</h3>
				<p class="max-w-prose text-muted">
					Group A and group B, one sorting turn, from the grid and the
					statements (test/sorting-turn-machine.test.ts checks each step).
				</p>
				<ol class="flex max-w-prose list-decimal flex-col gap-2 pl-6">
					<li>
						Free. Group A reads its waiting transactions and takes the turn
						(TAKE). The row gets A's id and an <Code>until</Code> 15 minutes on.
						Now Held.
					</li>
					<li>
						Held by A. A is asking Jev. When its save runs, the first statement
						checks the row still names A (HOLDS). It does, so the save may
						write. The turn stays Held.
					</li>
					<li>
						Ran out. A's 15 minutes pass before its save runs, so nothing is
						written and no release happens (EXPIRE). The row still names A, with
						an <Code>until</Code> in the past, so the turn reads Ran out. A
						check now would still pass if nobody has taken it (HOLDS).
					</li>
					<li>
						Held by B. Group B takes the turn that ran out (TAKE). The row
						becomes B's, with a fresh <Code>until</Code>.
					</li>
					<li>
						Held by B. A's save runs its check: the row names B, so no row
						matches and nothing is written. That is the statement's guard
						refusing the write, not the machine moving; the turn stays Held, now
						by B.
					</li>
				</ol>
			</div>
		</div>
	);
}

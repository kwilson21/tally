// A state machine as a table, read by machineGraph from the same definition the picture reads (MachineDiagram), so the
// table cannot drift from the rule. For a machine too tangled to draw as a picture: one row for each state, what it
// means, and every move out of it, each one in a sentence.
import type { AnyStateMachine } from "xstate";
import { machineGraph } from "../machines/graph";

const shown = (event: string) => event.toLowerCase().replaceAll("_", " ");

/** A machine as a table: one row for each state, in the machine's order, with what it means and what moves it. */
export function MachineTable({
	id,
	title,
	machine,
	labels,
}: {
	id: string;
	title: string;
	machine: AnyStateMachine;
	labels: Record<string, string>;
}) {
	const { nodes, edges } = machineGraph(machine);
	const label = (key: string) => labels[key] ?? key;

	return (
		<table id={id} class="mt-2 w-full border-collapse text-sm">
			<caption class="mb-2 text-left font-serif text-xl font-semibold">
				{title}
			</caption>
			<thead>
				<tr class="align-bottom">
					<th scope="col" class="pb-2 pr-4 text-left font-semibold">
						State
					</th>
					<th scope="col" class="pb-2 pr-4 text-left font-semibold">
						What it means
					</th>
					<th scope="col" class="pb-2 text-left font-semibold">
						What moves it
					</th>
				</tr>
			</thead>
			<tbody>
				{nodes.map((node) => {
					const moves = edges.filter((e) => e.from === node.key);

					return (
						<tr class="border-t border-rule align-top">
							<th scope="row" class="py-3 pr-4 text-left font-semibold">
								{label(node.key)}
							</th>
							<td class="max-w-prose py-3 pr-4 break-words text-muted">
								{node.words}
							</td>
							<td class="py-3 break-words">
								{moves.length === 0 ? (
									<p class="text-muted">Nothing moves it.</p>
								) : (
									<ul class="space-y-1">
										{moves.map((e) => (
											<li>
												<b class="font-semibold">{shown(e.event)}</b>{" "}
												{e.to === e.from
													? "stays here"
													: `goes to ${label(e.to)}`}
												: {e.words}
											</li>
										))}
									</ul>
								)}
							</td>
						</tr>
					);
				})}
			</tbody>
		</table>
	);
}

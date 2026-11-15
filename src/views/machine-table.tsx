// A state machine as tables, read by machineGraph from the same definition the picture reads (MachineDiagram), so the
// tables cannot drift from the rule. For a machine too tangled to draw as a picture: its moves grouped by what sets
// them off, one table for each group, with where each move starts, where it goes and what happens.
import type { AnyStateMachine } from "xstate";
import { machineGraph } from "../machines/graph";

// One heading of the table: its title, then the events it groups (the machine's own event names).
type MoveGroup = { title: string; events: readonly string[] };

/**
 * Throws unless every event of the machine is in exactly one group, and every group names only events of the machine.
 * A table that left a move out, or said one twice, would tell a reader something the rule does not.
 */
function checkGroups(machine: AnyStateMachine, groups: readonly MoveGroup[]) {
	const { edges } = machineGraph(machine);
	const events = new Set(edges.map((e) => e.event));
	const count = new Map<string, number>();

	for (const group of groups)
		for (const event of group.events) {
			if (!events.has(event))
				throw new Error(
					`Machine "${machine.id}": the group "${group.title}" names "${event}", which is not an event of the machine`,
				);

			count.set(event, (count.get(event) ?? 0) + 1);
		}

	for (const event of events) {
		const n = count.get(event) ?? 0;

		if (n !== 1)
			throw new Error(
				`Machine "${machine.id}": the event "${event}" is in ${n} groups, and must be in exactly one`,
			);
	}
}

/**
 * A machine as tables: one table for each group of its moves, in the groups' order, each with a caption and a row for
 * every move of its events, in the machine's state order. A move back to its own state says "stays".
 */
export function MachineTable({
	id,
	title,
	machine,
	labels,
	groups,
}: {
	id: string;
	title: string;
	machine: AnyStateMachine;
	labels: Record<string, string>;
	groups: readonly MoveGroup[];
}) {
	checkGroups(machine, groups);

	const { nodes, edges } = machineGraph(machine);
	const label = (key: string) => labels[key] ?? key;

	return (
		<div id={id} class="flex flex-col gap-6">
			<h3 class="font-serif text-xl font-semibold">{title}</h3>
			{groups.map((group) => {
				const rows = nodes.flatMap((node) =>
					edges.filter(
						(e) => e.from === node.key && group.events.includes(e.event),
					),
				);

				return (
					<table class="w-full border-collapse text-sm">
						<caption class="mb-2 text-left font-semibold">
							{group.title}
						</caption>
						<thead>
							<tr class="align-bottom">
								<th scope="col" class="pb-2 pr-4 text-left font-semibold">
									From
								</th>
								<th scope="col" class="pb-2 pr-4 text-left font-semibold">
									To
								</th>
								<th scope="col" class="pb-2 text-left font-semibold">
									What happens
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((e) => (
								<tr class="border-t border-rule align-top">
									<th scope="row" class="py-3 pr-4 text-left font-semibold">
										{label(e.from)}
									</th>
									<td class="py-3 pr-4 break-words">
										{e.to === e.from ? "stays" : label(e.to)}
									</td>
									<td class="py-3 break-words">{e.words}</td>
								</tr>
							))}
						</tbody>
					</table>
				);
			})}
		</div>
	);
}

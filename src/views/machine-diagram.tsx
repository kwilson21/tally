// A state machine drawn by Pele (decision 181) from the machine's definition by machineGraph, so the picture is the
// rule: add a state or an event and it appears here. Boxes are states, top to bottom in the order a thing moves
// through them; a finished state is shaded; a short word on each arrow names the event. The list under the picture
// says every arrow in a sentence.
import type { AnyStateMachine } from "xstate";
import { machineGraph } from "../machines/graph";
import { PeleDiagram } from "./pele-diagram";

const shown = (event: string) => event.toLowerCase().replaceAll("_", " ");
const text = (words: string) => words.replaceAll('"', "'");

/** The Mermaid text for a machine: one box for each state, one arrow for each pair of states with its events. */
export function machineSource(
	machine: AnyStateMachine,
	labels: Record<string, string>,
): string {
	const { initial, nodes, edges } = machineGraph(machine);
	const label = (key: string) => labels[key] ?? key;
	const lines = ["stateDiagram-v2", "  direction TB"];
	for (const node of nodes)
		lines.push(`  state "${text(label(node.key))}" as ${node.key}`);
	lines.push(`  [*] --> ${initial}`);
	const pairs = new Map<
		string,
		{ from: string; to: string; events: string[] }
	>();
	for (const edge of edges) {
		const key = `${edge.from}>${edge.to}`;
		const pair = pairs.get(key) ?? {
			from: edge.from,
			to: edge.to,
			events: [],
		};
		pair.events.push(shown(edge.event));
		pairs.set(key, pair);
	}
	for (const pair of pairs.values())
		lines.push(`  ${pair.from} --> ${pair.to}: ${pair.events.join(", ")}`);
	const finals = nodes.filter((n) => n.final).map((n) => n.key);
	if (finals.length > 0) lines.push(`  class ${finals.join(",")} done`);
	return lines.join("\n");
}

export function MachineDiagram({
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
	const { initial, edges } = machineGraph(machine);
	const label = (key: string) => labels[key] ?? key;
	const desc = `${label(initial)} is where it starts. ${edges
		.map((e) => `${label(e.from)} goes to ${label(e.to)} on ${shown(e.event)}.`)
		.join(" ")}`;

	return (
		<div>
			<div class="max-w-md">
				<PeleDiagram
					id={id}
					title={title}
					desc={desc}
					source={machineSource(machine, labels)}
				/>
			</div>
			{/* A definition list, not a bulleted one: the rules of a section sit in its fold (decision 126), and this is
			    the picture's words, one arrow to a line. */}
			<dl class="mt-3 space-y-1 text-sm">
				{edges.map((e) => (
					<div>
						<dt class="inline font-semibold">
							{label(e.from)} → {label(e.to)} on {shown(e.event)}:
						</dt>{" "}
						<dd class="inline">{e.words}.</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

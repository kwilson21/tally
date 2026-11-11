import type { AnyStateMachine } from "xstate";

/** One arrow of a machine: the event that moves it, where from and to, and the plain words for it. */
export type Edge = { from: string; to: string; event: string; words: string };

/** One state of a machine: its key, whether it ends the story, and the plain words for it. */
export type Node = { key: string; final: boolean; words: string };

// The parts of a state's definition the diagrams read; the machines here are written by hand with just these.
type TransitionConfig = { target?: unknown; description?: string };

type StateConfig = {
	type?: string;
	description?: string;
	on?: Record<string, TransitionConfig | TransitionConfig[]>;
};

/**
 * A machine as a list of states and arrows, read straight from its definition. The diagrams on How Tally works
 * and in the design-system catalog draw from this, so a picture cannot disagree with the rule it shows.
 */
export function machineGraph(machine: AnyStateMachine): {
	initial: string;
	nodes: Node[];
	edges: Edge[];
} {
	const states = (machine.config.states ?? {}) as Record<string, StateConfig>;
	const nodes: Node[] = [];
	const edges: Edge[] = [];

	for (const [key, state] of Object.entries(states)) {
		nodes.push({
			key,
			final: state.type === "final",
			words: state.description ?? key,
		});

		for (const [event, raw] of Object.entries(state.on ?? {})) {
			for (const transition of Array.isArray(raw) ? raw : [raw]) {
				if (
					typeof transition !== "object" ||
					transition === null ||
					typeof transition.target !== "string"
				) {
					throw new Error(
						`Machine "${machine.id}": ${key}.${event} must be an object with a string target`,
					);
				}

				edges.push({
					from: key,
					to: transition.target,
					event,
					words: transition.description ?? event,
				});
			}
		}
	}

	return { initial: String(machine.config.initial), nodes, edges };
}

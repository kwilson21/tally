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

// True for a transition object whose target is a string. The diagrams need that target to draw the arrow.
function hasStringTarget(
	value: unknown,
): value is TransitionConfig & { target: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"target" in value &&
		typeof value.target === "string"
	);
}

/** A machine as the diagrams read it: its start state, its states, and its arrows. */
export type MachineGraph = { initial: string; nodes: Node[]; edges: Edge[] };

/**
 * A machine as a list of states and arrows, read straight from its definition. The diagrams on How Tally works
 * and in the design-system catalog draw from this, so a picture cannot disagree with the rule it shows.
 */
export function machineGraph(machine: AnyStateMachine): MachineGraph {
	// SAFETY: the machines drawn here are hand-written with only the StateConfig fields (type, description, on), so their config states match that shape.
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
				if (!hasStringTarget(transition)) {
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

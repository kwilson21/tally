/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { AnyStateMachine } from "xstate";
import {
	CATEGORY_SUGGESTION_LABELS,
	categorySuggestionMachine,
} from "../src/machines/category-suggestion";
import { machineGraph } from "../src/machines/graph";
import {
	MERCHANT_SUGGESTION_LABELS,
	merchantSuggestionMachine,
} from "../src/machines/merchant-suggestion";
import {
	SORTING_TURN_LABELS,
	sortingTurnMachine,
} from "../src/machines/sorting-turn";
import { MachineDiagram, machineSource } from "../src/views/machine-diagram";

const draw = (machine: AnyStateMachine, labels: Record<string, string>) =>
	String(
		MachineDiagram({ id: "d", title: "A test machine", machine, labels }),
	).replaceAll("&#39;", "'");

const MACHINES = [
	[categorySuggestionMachine, CATEGORY_SUGGESTION_LABELS],
	[merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS],
	[sortingTurnMachine, SORTING_TURN_LABELS],
] as const;

// The machine's definition as written, read straight from `config` and not through machineGraph, so these checks can
// fail when machineGraph or the picture drops or adds an arrow.
type RawTransition = { target?: unknown; description?: string };

type RawState = {
	type?: string;
	description?: string;
	on?: Record<string, RawTransition | RawTransition[]>;
};

type RawStates = Record<string, RawState>;

// SAFETY: the machines drawn here are hand-written with only the fields RawState names (type, description, on).
const configStates = (machine: AnyStateMachine) =>
	machine.config.states as RawStates;

const shownEvent = (event: string) => event.toLowerCase().replaceAll("_", " ");

// One entry per pair of states ("from --> to"), with the events on it, the way the picture merges them.
function rawArrows(states: RawStates): Map<string, string[]> {
	const arrows = new Map<string, string[]>();

	for (const [from, state] of Object.entries(states))
		for (const [event, raw] of Object.entries(state.on ?? {}))
			for (const transition of Array.isArray(raw) ? raw : [raw]) {
				const key = `${from} --> ${String(transition.target)}`;
				arrows.set(key, [...(arrows.get(key) ?? []), shownEvent(event)]);
			}

	for (const events of arrows.values()) events.sort();

	return arrows;
}

// The arrows the picture's Mermaid text draws: one line for each pair of states, with its events after a colon.
function pictureArrows(source: string): Map<string, string[]> {
	const arrows = new Map<string, string[]>();

	for (const match of source.matchAll(/^\s+(\w+) --> (\w+): (.+)$/gm))
		arrows.set(`${match[1]} --> ${match[2]}`, match[3].split(", ").sort());

	return arrows;
}

const finalStates = (states: RawStates) =>
	Object.keys(states)
		.filter((key) => states[key].type === "final")
		.sort();

// The states the picture's `class ... done` line shades.
function pictureShaded(source: string): string[] {
	const match = source.match(/^\s+class (.+) done$/m);

	return match ? match[1].split(",").sort() : [];
}

describe("MachineDiagram", () => {
	it("draws a box for every state and says every arrow in a sentence, read from the machine", () => {
		for (const [machine, labels] of MACHINES) {
			const html = draw(machine, labels);
			const { nodes, edges } = machineGraph(machine);
			expect(html.match(/class="pele-node pele-state[ "]/g)).toHaveLength(
				nodes.length,
			);
			expect(html.match(/<dt /g)).toHaveLength(edges.length);

			for (const edge of edges) expect(html).toContain(`${edge.words}.`);

			for (const node of nodes) expect(html).toContain(`>${labels[node.key]}<`);
		}
	});

	it("gives every state of every drawn machine a label, not just its key", () => {
		for (const [machine, labels] of MACHINES) {
			const source = machineSource(machine, labels);

			for (const key of Object.keys(configStates(machine))) {
				const label = labels[key];
				expect(label, `${machine.id}.${key}`).toBeTruthy();
				expect(source).toContain(`state "${label}" as ${key}`);
			}
		}
	});

	it("draws exactly the arrows the machine's config has, one per pair of states, with every event on it", () => {
		for (const [machine, labels] of MACHINES) {
			const source = machineSource(machine, labels);
			expect(pictureArrows(source), machine.id).toEqual(
				rawArrows(configStates(machine)),
			);
		}
	});

	it("fails when the picture and the config disagree on one arrow", () => {
		// The check run on the sorting turn's config with one transition taken out (held -> free on release) and on one
		// with an extra arrow (free -> expired on a made-up event): both must differ from the picture.
		const states = configStates(sortingTurnMachine);

		const picture = pictureArrows(
			machineSource(sortingTurnMachine, SORTING_TURN_LABELS),
		);

		const missing = {
			...states,
			held: {
				...states.held,
				on: Object.fromEntries(
					Object.entries(states.held.on ?? {}).filter(
						([event]) => event !== "RELEASE",
					),
				),
			},
		} satisfies RawStates;

		expect(picture).not.toEqual(rawArrows(missing));

		const extra = {
			...states,
			free: {
				...states.free,
				on: { ...states.free.on, MADE_UP: { target: "expired" } },
			},
		} satisfies RawStates;

		expect(picture).not.toEqual(rawArrows(extra));
	});

	it("says each pair of states once, with all its events on one arrow", () => {
		const source = machineSource(
			merchantSuggestionMachine,
			MERCHANT_SUGGESTION_LABELS,
		);

		expect(source).toContain("none --> pending: bank name, names");
		expect(source).toContain("pending --> pending: bank name");
	});

	it("shades every finished state of the config and no other, and draws no end marker after them", () => {
		for (const [machine, labels] of MACHINES) {
			const states = configStates(machine);
			const source = machineSource(machine, labels);
			expect(pictureShaded(source), machine.id).toEqual(finalStates(states));
			const html = draw(machine, labels);
			expect(html.match(/pele-state done"/g)?.length ?? 0, machine.id).toBe(
				finalStates(states).length,
			);
			expect(html).not.toContain("pele-state-end");
		}
	});

	it("says every state and every arrow of the sorting turn in plain words, not just its event names", () => {
		for (const machine of [sortingTurnMachine]) {
			for (const [key, state] of Object.entries(configStates(machine))) {
				expect(state.description, `${machine.id}.${key}`).toBeTruthy();

				for (const [event, raw] of Object.entries(state.on ?? {}))
					for (const transition of Array.isArray(raw) ? raw : [raw])
						expect(
							transition.description,
							`${machine.id}.${key}.${event}`,
						).toBeTruthy();
			}
		}
	});

	it("is one labelled picture whose description walks the arrows", () => {
		const html = draw(merchantSuggestionMachine, MERCHANT_SUGGESTION_LABELS);
		expect(html).toContain('role="img"');
		expect(html).toContain('aria-labelledby="d-title d-desc"');
		expect(html).toContain("None is where it starts.");
		expect(html).toContain("Waiting goes to Accepted on accept.");
	});

	it("keeps every word inside the picture's frame", () => {
		for (const [machine, labels] of MACHINES) {
			const html = draw(machine, labels);
			const frame = html.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
			const width = Number(frame?.[1]);
			const height = Number(frame?.[2]);
			expect(width).toBeGreaterThan(0);
			expect(width).toBeLessThanOrEqual(520);

			for (const word of html.matchAll(
				/<text[^>]* x="([-\d.]+)" y="([-\d.]+)"/g,
			)) {
				expect(Number(word[1])).toBeGreaterThanOrEqual(0);
				expect(Number(word[1])).toBeLessThanOrEqual(width);
				expect(Number(word[2])).toBeGreaterThanOrEqual(0);
				expect(Number(word[2])).toBeLessThanOrEqual(height);
			}
		}
	});
});

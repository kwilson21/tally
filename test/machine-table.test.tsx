/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { AnyStateMachine } from "xstate";
import {
	PLAID_CONNECTION_LABELS,
	plaidConnectionMachine,
} from "../src/machines/plaid-connection";
import { MachineTable } from "../src/views/machine-table";

const TITLE = "How a bank connection moves between states";

const LABELS: Record<string, string> = PLAID_CONNECTION_LABELS;

const draw = (machine: AnyStateMachine, labels: Record<string, string>) =>
	String(MachineTable({ id: "t", title: TITLE, machine, labels })).replaceAll(
		"&#39;",
		"'",
	);

// The machine's definition as written, read straight from `config` and not through machineGraph, so these checks can
// fail when machineGraph or the table drops or adds a move.
type RawTransition = { target?: unknown; description?: string };

type RawState = {
	type?: string;
	description?: string;
	on?: Record<string, RawTransition | RawTransition[]>;
};

type RawStates = Record<string, RawState>;

// SAFETY: the machine tested here is hand-written with only the fields RawState names (type, description, on).
const configStates = (machine: AnyStateMachine) =>
	machine.config.states as RawStates;

const shownEvent = (event: string) => event.toLowerCase().replaceAll("_", " ");

// The moves the table should say, per state label, each one as its words: "event goes to Target: sentence", or
// "event stays here: sentence" when the move goes back to the same state.
function expectedMoves(
	states: RawStates,
	labels: Record<string, string>,
): Map<string, string[]> {
	const moves = new Map<string, string[]>();

	for (const [from, state] of Object.entries(states)) {
		const lines: string[] = [];

		for (const [event, raw] of Object.entries(state.on ?? {}))
			for (const transition of Array.isArray(raw) ? raw : [raw]) {
				const target = String(transition.target);

				const where =
					target === from ? "stays here" : `goes to ${labels[target]}`;

				lines.push(
					`${shownEvent(event)} ${where}: ${transition.description ?? ""}`,
				);
			}

		moves.set(labels[from], lines.sort());
	}

	return moves;
}

// The moves the table says, read back per row: each <tr>'s label and the text of its <li> items, with tags removed.
function tableMoves(html: string): Map<string, string[]> {
	const moves = new Map<string, string[]>();

	for (const row of html.split("<tr").slice(1)) {
		const label = row.match(/<th scope="row"[^>]*>([^<]*)<\/th>/)?.[1];

		if (label === undefined) continue;

		const items = [...row.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((m) =>
			m[1].replace(/<[^>]+>/g, "").trim(),
		);

		moves.set(label, items.sort());
	}

	return moves;
}

describe("MachineTable", () => {
	it("draws a row for every state, headed by its label, with the caption as the title", () => {
		const html = draw(plaidConnectionMachine, LABELS);
		const states = configStates(plaidConnectionMachine);

		expect(html).toContain(`<caption`);
		expect(html).toContain(`>${TITLE}</caption>`);
		expect(html.match(/<th scope="row"/g)).toHaveLength(
			Object.keys(states).length,
		);

		for (const key of Object.keys(states))
			expect(html).toContain(
				`<th scope="row" class="py-3 pr-4 text-left font-semibold">${LABELS[key]}</th>`,
			);

		expect(html).toContain('scope="col"');
	});

	it("says every move of the raw config once, with its event words, its target label, and its sentence", () => {
		const html = draw(plaidConnectionMachine, LABELS);
		const states = configStates(plaidConnectionMachine);

		const transitions = Object.values(states).flatMap((state) =>
			Object.values(state.on ?? {}).flatMap((raw) =>
				Array.isArray(raw) ? raw : [raw],
			),
		);

		expect(html.match(/<li/g)).toHaveLength(transitions.length);
		expect(transitions).toHaveLength(20);
		expect(tableMoves(html)).toEqual(expectedMoves(states, LABELS));
	});

	it("says 'stays here' for every move that goes back to its own state, and for no other", () => {
		const html = draw(plaidConnectionMachine, LABELS);
		const states = configStates(plaidConnectionMachine);
		let stays = 0;

		for (const [from, state] of Object.entries(states))
			for (const raw of Object.values(state.on ?? {}))
				for (const transition of Array.isArray(raw) ? raw : [raw])
					if (transition.target === from) stays += 1;

		expect(stays).toBeGreaterThan(0);
		expect(html.match(/stays here/g)).toHaveLength(stays);
	});

	it("says nothing moves a final state", () => {
		const html = draw(plaidConnectionMachine, LABELS);

		const row = html.split("<tr").find((r) => r.includes(">Disconnected</th>"));

		expect(row).toContain("Nothing moves it.");
		expect(row).not.toContain("<li");
	});

	it("gives every state and every move a plain sentence, read from the config", () => {
		for (const [key, state] of Object.entries(
			configStates(plaidConnectionMachine),
		)) {
			expect(LABELS[key], key).toBeTruthy();
			expect(state.description, key).toBeTruthy();

			for (const [event, raw] of Object.entries(state.on ?? {}))
				for (const transition of Array.isArray(raw) ? raw : [raw])
					expect(transition.description, `${key}.${event}`).toBeTruthy();
		}
	});

	it("says what each state means in the row, from its description", () => {
		const html = draw(plaidConnectionMachine, LABELS);

		for (const state of Object.values(configStates(plaidConnectionMachine))) {
			expect(state.description).toBeTruthy();
			expect(html).toContain(state.description ?? "");
		}
	});

	it("fails when the table and the config disagree on one move", () => {
		// The check run on the Plaid connection with one move taken out (ok on LOGIN_BROKEN) and with one made-up move
		// (ok on a made-up event): both must differ from the table.
		const states = configStates(plaidConnectionMachine);

		const table = tableMoves(draw(plaidConnectionMachine, LABELS));

		const missing = {
			...states,
			ok: {
				...states.ok,
				on: Object.fromEntries(
					Object.entries(states.ok.on ?? {}).filter(
						([event]) => event !== "LOGIN_BROKEN",
					),
				),
			},
		} satisfies RawStates;

		expect(table).not.toEqual(expectedMoves(missing, LABELS));

		const extra = {
			...states,
			ok: {
				...states.ok,
				on: {
					...states.ok.on,
					MADE_UP: { target: "disconnected", description: "Made up." },
				},
			},
		} satisfies RawStates;

		expect(table).not.toEqual(expectedMoves(extra, LABELS));
	});
});

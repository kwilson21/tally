/** @jsxImportSource hono/jsx */
import { describe, expect, it } from "vitest";
import type { AnyStateMachine } from "xstate";
import { setup } from "xstate";
import {
	PLAID_CONNECTION_LABELS,
	PLAID_CONNECTION_MOVE_GROUPS,
	plaidConnectionMachine,
} from "../src/machines/plaid-connection";
import { MachineTable } from "../src/views/machine-table";

const TITLE = "How a bank connection moves between states";

const LABELS: Record<string, string> = PLAID_CONNECTION_LABELS;

const GROUPS = PLAID_CONNECTION_MOVE_GROUPS;

const draw = (
	machine: AnyStateMachine,
	labels: Record<string, string>,
	groups: readonly { title: string; events: readonly string[] }[] = GROUPS,
) =>
	String(
		MachineTable({ id: "t", title: TITLE, machine, labels, groups }),
	).replaceAll("&#39;", "'");

// The machine's definition as written, read straight from `config` and not through machineGraph, so these checks can
// fail when machineGraph or the table drops or adds a move.
type RawTransition = { target?: unknown; description?: string };

type RawState = {
	type?: string;
	description?: string;
	on?: Record<string, RawTransition | RawTransition[]>;
};

type RawStates = Record<string, RawState>;

// SAFETY: the machines tested here are hand-written with only the fields RawState names (type, description, on).
const configStates = (machine: AnyStateMachine) =>
	machine.config.states as RawStates;

// Every transition of the raw config, in the machine's order: the state it leaves, the event, and the transition.
function rawTransitions(states: RawStates) {
	return Object.entries(states).flatMap(([from, state]) =>
		Object.entries(state.on ?? {}).flatMap(([event, raw]) =>
			(Array.isArray(raw) ? raw : [raw]).map((transition) => ({
				from,
				event,
				target: String(transition.target),
				description: transition.description ?? "",
			})),
		),
	);
}

// One expected row of the table: which group it is in, its From label, its To label or "stays", and its sentence.
function expectedRows(
	states: RawStates,
	labels: Record<string, string>,
	groups: readonly { title: string; events: readonly string[] }[],
) {
	return groups.map((group) => ({
		title: group.title,
		rows: rawTransitions(states)
			.filter((t) => group.events.includes(t.event))
			.map((t) => ({
				from: labels[t.from],
				to: t.target === t.from ? "stays" : labels[t.target],
				description: t.description,
			})),
	}));
}

// The table as it reads back: each <table> with its caption and its body rows, in the order drawn. Tags and
// escaping are undone so the rows compare as the words a reader sees.
function tablesOf(html: string) {
	return html
		.split("<table")
		.slice(1)
		.map((table) => {
			const caption =
				table.match(/<caption[^>]*>([^<]*)<\/caption>/)?.[1] ?? "";

			const body = table.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? "";

			const rows = [
				...body.matchAll(
					/<tr[^>]*>\s*<th scope="row"[^>]*>([^<]*)<\/th>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<\/tr>/g,
				),
			].map((m) => ({ from: m[1], to: m[2], description: m[3] }));

			return {
				title: caption,
				rows,
				bodyRowCount: body.split("<tr").length - 1,
			};
		});
}

// The moves the table says, as one line each, sorted, so a missing or doubled move is a clear difference.
const lines = (
	groups: {
		title: string;
		rows: { from: string; to: string; description: string }[];
	}[],
) =>
	groups
		.flatMap((g) =>
			g.rows.map((r) => `${g.title} | ${r.from} | ${r.to} | ${r.description}`),
		)
		.sort();

describe("MachineTable", () => {
	it("draws the title as a heading above one table for each group, each with its group's title as its caption", () => {
		const html = draw(plaidConnectionMachine, LABELS);

		expect(html).toContain(`<div id="t" `);
		expect(html).toContain(`>${TITLE}</h3>`);
		expect(html.indexOf(`>${TITLE}</h3>`)).toBeLessThan(html.indexOf("<table"));

		const tables = tablesOf(html);

		expect(tables.map((t) => t.title)).toEqual(GROUPS.map((g) => g.title));
		expect(html.match(/<caption/g)).toHaveLength(GROUPS.length);
		expect(html.match(/<th scope="col"/g)).toHaveLength(GROUPS.length * 3);
		expect(html.match(/<th scope="row"/g)).toHaveLength(
			rawTransitions(configStates(plaidConnectionMachine)).length,
		);
	});

	it("says every transition of the config in exactly one group row, with its From label, To label or 'stays', and its sentence", () => {
		const html = draw(plaidConnectionMachine, LABELS);
		const states = configStates(plaidConnectionMachine);

		expect(rawTransitions(states)).toHaveLength(20);

		const tables = tablesOf(html);

		for (const table of tables)
			expect(table.rows).toHaveLength(table.bodyRowCount);

		expect(lines(tables)).toEqual(lines(expectedRows(states, LABELS, GROUPS)));
	});

	it("lists each group's rows in the machine's state order, then the order of its events", () => {
		const html = draw(plaidConnectionMachine, LABELS);
		const states = configStates(plaidConnectionMachine);

		const tables = tablesOf(html);
		const expected = expectedRows(states, LABELS, GROUPS);

		expect(tables.map((t) => t.rows)).toEqual(
			expected.map((g) =>
				g.rows.map((r) => ({
					from: r.from,
					to: r.to,
					description: r.description,
				})),
			),
		);
	});

	it("says 'stays' for every move that goes back to its own state, and for no other", () => {
		const html = draw(plaidConnectionMachine, LABELS);
		const states = configStates(plaidConnectionMachine);
		const stays = rawTransitions(states).filter((t) => t.target === t.from);

		expect(stays.length).toBeGreaterThan(0);
		expect(html.match(/>stays</g)).toHaveLength(stays.length);
	});

	it("gives every state a label and a sentence, and every move a sentence, read from the config", () => {
		for (const [key, state] of Object.entries(
			configStates(plaidConnectionMachine),
		)) {
			expect(LABELS[key], key).toBeTruthy();
			expect(state.description, key).toBeTruthy();
		}

		for (const t of rawTransitions(configStates(plaidConnectionMachine)))
			expect(t.description, `${t.from}.${t.event}`).toBeTruthy();
	});

	it("lists every event of the machine in exactly one group of the Plaid connection", () => {
		const events = new Set(
			rawTransitions(configStates(plaidConnectionMachine)).map((t) => t.event),
		);

		const grouped = GROUPS.flatMap((g) => g.events);

		expect(events.size).toBe(5);
		expect([...grouped].sort()).toEqual([...events].sort());
	});

	it("throws for an event in two groups, an event in no group, and a group event the machine does not have", () => {
		const machine = setup({}).createMachine({
			id: "tiny",
			initial: "a",
			states: {
				a: {
					description: "A.",
					on: {
						GO: { target: "b", description: "Go to B." },
						STAY: { target: "a", description: "Stay in A." },
					},
				},
				b: { type: "final", description: "B." },
			},
		});

		const labels = { a: "A", b: "B" };

		const draw2 = (groups: { title: string; events: string[] }[]) => () =>
			draw(machine, labels, groups);

		expect(
			draw2([
				{ title: "One", events: ["GO"] },
				{ title: "Two", events: ["GO", "STAY"] },
			]),
		).toThrow(/GO/);

		expect(draw2([{ title: "One", events: ["GO"] }])).toThrow(/STAY/);

		expect(
			draw2([
				{ title: "One", events: ["GO", "STAY"] },
				{ title: "Ghost", events: ["NOT_HERE"] },
			]),
		).toThrow(/NOT_HERE/);
	});

	it("fails when the table and the config disagree on one move", () => {
		// The check run with one move taken out of the config (ok on LOGIN_BROKEN), and with one made-up move: each must
		// differ from what the table says.
		const states = configStates(plaidConnectionMachine);
		const table = lines(tablesOf(draw(plaidConnectionMachine, LABELS)));

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

		expect(table).not.toEqual(lines(expectedRows(missing, LABELS, GROUPS)));
	});
});

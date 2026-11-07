// A state machine drawn as boxes and arrows (How Tally works, the design-system catalog). Read straight from the
// machine's definition by machineGraph, so the picture is the rule: add a state or an event and it appears here.
// Boxes are states, left to right in the order a thing moves through them; a finished state is shaded. A short word
// on each arrow names the event, and the list under the picture says every arrow in a sentence. Sized for 390px.
import type { AnyStateMachine } from "xstate";
import { type Edge, machineGraph } from "../machines/graph";

const W = 360;
const BW = 76;
const BH = 40;
const PITCH = 72;
const LEFT = 24;
const RIGHT = 8;
const LOOP_ROOM = 34;
const TOP = 12;

type Point = { x: number; y: number };

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
	const { initial, nodes, edges } = machineGraph(machine);
	const label = (key: string) => labels[key] ?? key;

	// Column of each state: how many arrows from the first state it takes to reach it.
	const column = new Map<string, number>([[initial, 0]]);
	for (let i = 0; i < nodes.length; i++) {
		for (const edge of edges) {
			const from = column.get(edge.from);
			if (from !== undefined && !column.has(edge.to))
				column.set(edge.to, from + 1);
		}
	}
	for (const node of nodes) if (!column.has(node.key)) column.set(node.key, 0);
	const columns = Math.max(...column.values()) + 1;
	const members = (c: number) =>
		nodes.filter((n) => column.get(n.key) === c).map((n) => n.key);
	const tallest = Math.max(
		...Array.from({ length: columns }, (_, c) => members(c).length),
	);
	const backEdges = edges.some(
		(e) => (column.get(e.to) ?? 0) < (column.get(e.from) ?? 0),
	);
	const hasLoop = edges.some((e) => e.from === e.to);
	const top = TOP + (hasLoop ? LOOP_ROOM : 0);
	const innerHeight = (tallest - 1) * PITCH + BH;
	const height = top + innerHeight + (backEdges ? 44 : 16);
	const centerY = top + innerHeight / 2;

	const place = new Map<string, Point>();
	for (let c = 0; c < columns; c++) {
		const keys = members(c);
		const x =
			columns === 1
				? W / 2
				: LEFT + BW / 2 + (c * (W - LEFT - RIGHT - BW)) / (columns - 1);
		keys.forEach((key, r) => {
			place.set(key, { x, y: centerY + (r - (keys.length - 1) / 2) * PITCH });
		});
	}
	const at = (key: string) => place.get(key) as Point;

	const arrows = edges.map((edge) =>
		arrow(edge, at, column, centerY + innerHeight / 2),
	);
	const desc = `${label(initial)} is where it starts. ${edges
		.map(
			(e) =>
				`${label(e.from)} goes to ${label(e.to)} on ${e.event.toLowerCase()}.`,
		)
		.join(" ")}`;
	const start = at(initial);

	return (
		<div>
			<svg
				class="h-auto w-full max-w-md"
				viewBox={`0 0 ${W} ${height}`}
				fill="none"
				stroke-width="1.75"
				stroke-linecap="round"
				stroke-linejoin="round"
				role="img"
				aria-labelledby={`${id}-title ${id}-desc`}
			>
				<title id={`${id}-title`}>{title}</title>
				<desc id={`${id}-desc`}>{desc}</desc>
				<defs>
					<marker
						id={`${id}-head`}
						viewBox="0 0 10 10"
						refX="9"
						refY="5"
						markerWidth="9"
						markerHeight="9"
						markerUnits="userSpaceOnUse"
						orient="auto-start-reverse"
					>
						<path d="M1 1 L9 5 L1 9" class="stroke-ink" fill="none" />
					</marker>
				</defs>
				{/* The way in: a dot and a short arrow into the first state. */}
				<circle cx="6" cy={start.y} r="3" class="fill-ink stroke-ink" />
				<path
					d={`M9 ${start.y} H${start.x - BW / 2 - 1}`}
					class="stroke-ink"
					marker-end={`url(#${id}-head)`}
				/>
				{arrows.map((a) => (
					<path d={a.path} class="stroke-ink" marker-end={`url(#${id}-head)`} />
				))}
				{nodes.map((node) => {
					const p = at(node.key);
					return (
						<g>
							<rect
								x={p.x - BW / 2}
								y={p.y - BH / 2}
								width={BW}
								height={BH}
								rx="8"
								class={
									node.final ? "fill-band stroke-ink" : "fill-paper stroke-ink"
								}
							/>
							<text
								x={p.x}
								y={p.y + 4}
								text-anchor="middle"
								font-size="12"
								class="fill-ink stroke-none"
							>
								{label(node.key)}
							</text>
						</g>
					);
				})}
				{arrows.map((a) => (
					<text
						x={a.label.x}
						y={a.label.y}
						text-anchor="middle"
						font-size="11"
						stroke-width="4"
						paint-order="stroke"
						class="fill-muted stroke-paper"
					>
						{a.event.toLowerCase()}
					</text>
				))}
			</svg>
			{/* A definition list, not a bulleted one: the rules of a section sit in its fold (decision 126), and this is
			    the picture's words, one arrow to a line. */}
			<dl class="mt-3 space-y-1 text-sm">
				{edges.map((e) => (
					<div>
						<dt class="inline font-semibold">
							{label(e.from)} → {label(e.to)} on {e.event.toLowerCase()}:
						</dt>{" "}
						<dd class="inline">{e.words}.</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

type Drawn = { path: string; label: Point; event: string };

// One arrow's path and where its word sits. Forward arrows run straight from a box's right edge to the next
// box's left edge; an arrow back to an earlier column bends under the row; an arrow to the same state loops
// over the top of its box; two states in one column join with a straight vertical.
function arrow(
	edge: Edge,
	at: (key: string) => Point,
	column: Map<string, number>,
	bottom: number,
): Drawn {
	const a = at(edge.from);
	const b = at(edge.to);
	const event = edge.event;
	if (edge.from === edge.to) {
		const top = a.y - BH / 2;
		return {
			path: `M${a.x - 30} ${top} C${a.x - 30} ${top - 26} ${a.x - 4} ${top - 26} ${a.x - 4} ${top - 1}`,
			label: { x: a.x - 17, y: top - 29 },
			event,
		};
	}
	const ca = column.get(edge.from) ?? 0;
	const cb = column.get(edge.to) ?? 0;
	if (cb > ca) {
		const from = { x: a.x + BW / 2, y: a.y };
		const to = { x: b.x - BW / 2 - 1, y: b.y };
		return {
			path: `M${from.x} ${from.y} L${to.x} ${to.y}`,
			label: {
				x: from.x + (to.x - from.x) * 0.55,
				y: from.y + (to.y - from.y) * 0.55 - 6,
			},
			event,
		};
	}
	if (cb < ca) {
		const from = { x: a.x - 14, y: a.y + BH / 2 };
		const to = { x: b.x + 14, y: b.y + BH / 2 + 1 };
		const low = bottom + 24;
		return {
			path: `M${from.x} ${from.y} C${from.x} ${low} ${to.x} ${low} ${to.x} ${to.y}`,
			label: { x: (from.x + to.x) / 2, y: low - 4 },
			event,
		};
	}
	const down = b.y > a.y;
	const from = { x: a.x, y: a.y + (down ? BH / 2 : -BH / 2) };
	const to = { x: b.x, y: b.y + (down ? -BH / 2 - 1 : BH / 2 + 1) };
	return {
		path: `M${from.x} ${from.y} L${to.x} ${to.y}`,
		label: { x: from.x + 20, y: (from.y + to.y) / 2 + 4 },
		event,
	};
}

type Box = { x: number; y: number; w: number; lines: [string, string] };

const H = 56;
// A vertical layout so the text stays legible on a 390px phone: bank → server ↔ database in a
// column, with the two AI helpers below, fed from the server's sides.
const BOXES: Box[] = [
	{ x: 70, y: 4, w: 180, lines: ["Your bank", "(via Plaid)"] },
	{ x: 70, y: 100, w: 180, lines: ["Tally server", "(Cloudflare Worker)"] },
	{ x: 70, y: 200, w: 180, lines: ["Database", "(D1)"] },
	{ x: 4, y: 290, w: 150, lines: ["Jev:", "picks categories"] },
	{ x: 166, y: 290, w: 150, lines: ["Workers AI:", "suggests names"] },
];

/** The system diagram on How Tally works: the bank, the server, the database, and the two AI helpers. */
export function SystemDiagram() {
	return (
		<svg
			class="h-auto w-full max-w-sm"
			viewBox="0 0 320 350"
			fill="none"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			role="img"
			aria-labelledby="diagram-title diagram-desc"
		>
			<title id="diagram-title">How Tally's parts connect</title>
			<desc id="diagram-desc">
				Your bank sends transactions through Plaid to the Tally server, a
				Cloudflare Worker. The server reads and writes the D1 database, asks Jev
				to pick categories, and asks Workers AI to suggest merchant names.
			</desc>
			<g class="stroke-ink">
				{BOXES.map((b) => (
					<rect x={b.x} y={b.y} width={b.w} height={H} rx="8" />
				))}
				{/* Bank → server */}
				<path d="M160 60 V96 M154 90 L160 96 L166 90" />
				{/* Server ↔ database */}
				<path d="M160 156 V196 M154 190 L160 196 L166 190 M154 162 L160 156 L166 162" />
				{/* Server → Jev (down the left side) and Workers AI (down the right side) */}
				<path d="M70 128 H40 V286 M34 280 L40 286 L46 280" />
				<path d="M250 128 H280 V286 M274 280 L280 286 L286 280" />
			</g>
			<g class="fill-ink" font-size="15" text-anchor="middle">
				{BOXES.map((b) => [
					<text x={b.x + b.w / 2} y={b.y + 24}>
						{b.lines[0]}
					</text>,
					<text x={b.x + b.w / 2} y={b.y + 44} class="fill-muted">
						{b.lines[1]}
					</text>,
				])}
			</g>
		</svg>
	);
}

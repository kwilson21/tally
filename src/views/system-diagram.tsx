// The parts of Tally on How Tally works, drawn by Pele (decision 176): the bank feeds the server, which reads and
// writes the database and asks the two AI helpers. Top to bottom so the text stays legible on a 390px phone.
import { PeleDiagram } from "./pele-diagram";

const SOURCE = [
	"flowchart TB",
	'  bank["Your bank<br/>(via Plaid)"] --> server["Tally server<br/>(Cloudflare Worker)"]',
	'  server <--> db[("Database<br/>(D1)")]',
	'  server --> jev["Jev:<br/>picks categories"]',
	'  server --> ai["Workers AI:<br/>suggests names"]',
].join("\n");

/** The system diagram on How Tally works: the bank, the server, the database, and the two AI helpers. */
export function SystemDiagram() {
	return (
		<div class="max-w-sm">
			<PeleDiagram
				id="diagram"
				title="How Tally's parts connect"
				desc="Your bank sends transactions through Plaid to the Tally server, a Cloudflare Worker. The server reads and writes the D1 database, asks Jev to pick categories, and asks Workers AI to suggest merchant names."
				source={SOURCE}
			/>
		</div>
	);
}

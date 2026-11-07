// The one place Tally draws a diagram with Pele (decision 176): Mermaid text in, SVG out, on the server. Pele
// writes its colours and fonts as an inline `style` attribute, which the page's CSP (style-src 'self') refuses, so
// the attribute is dropped here and app.css's `.pele` rules supply the same variables from Tally's tokens.
import { raw } from "hono/html";
import { register, render } from "pele/core";
import flowchart from "pele/diagrams/flowchart";
import state from "pele/diagrams/state";

register(state, flowchart);

const escapeText = (text: string) =>
	text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");

/**
 * Draws Mermaid text as one labelled SVG picture. The title and description are ours, not Mermaid's, so a
 * description can say anything; `id` makes their ids unique on a page that holds several diagrams.
 */
export function peleSvg(
	source: string,
	{ id, title, desc }: { id: string; title: string; desc: string },
): string {
	const { svg } = render(source, {
		idPrefix: id,
		fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
	});
	return svg
		.replace(/\sstyle="[^"]*"/g, "")
		.replace(/\saria-roledescription="[^"]*"/, "")
		.replace(
			/\srole="[^"]*"/,
			` role="img" aria-labelledby="${id}-title ${id}-desc"`,
		)
		.replace(
			/^<svg[^>]*>/,
			// A function, not a string: a dollar amount in the description would be read as a replacement pattern.
			(open) =>
				`${open}<title id="${id}-title">${escapeText(title)}</title><desc id="${id}-desc">${escapeText(desc)}</desc>`,
		);
}

/** A diagram drawn by Pele, for a view to place. */
export function PeleDiagram(props: {
	id: string;
	title: string;
	desc: string;
	source: string;
}) {
	return raw(
		peleSvg(props.source, {
			id: props.id,
			title: props.title,
			desc: props.desc,
		}),
	);
}

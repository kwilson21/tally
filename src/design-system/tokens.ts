// The color tokens as the catalog shows them. The hex values must match app.css's @theme
// (test/design-tokens.test.ts); uses and contrast on paper are DESIGN.md's.
export const COLOR_TOKENS = [
	{
		name: "paper",
		hex: "#fbf8f2",
		swatch: "bg-paper",
		use: "page background",
		contrast: "—",
	},
	{
		name: "band",
		hex: "#efebe3",
		swatch: "bg-band",
		use: "the one highlighted row; demo banner",
		contrast: "—",
	},
	{
		name: "ink",
		hex: "#0e0e0e",
		swatch: "bg-ink",
		use: "text",
		contrast: "18.2",
	},
	{
		name: "muted",
		hex: "#4a4a4a",
		swatch: "bg-muted",
		use: "secondary text",
		contrast: "8.4",
	},
	{
		name: "rule",
		hex: "#e8e3da",
		swatch: "bg-rule",
		use: "dividers, empty bar track",
		contrast: "decorative",
	},
	{
		name: "accent",
		hex: "#ae5534",
		swatch: "bg-accent",
		use: "links, current nav (never on band)",
		contrast: "4.8",
	},
	{
		name: "ok",
		hex: "#2f7a4f",
		swatch: "bg-ok",
		use: "on-track bar",
		contrast: "4.9",
	},
	{
		name: "over",
		hex: "#a93226",
		swatch: "bg-over",
		use: "over budget: bar, icon, word",
		contrast: "6.3",
	},
	{
		name: "cat-blue",
		hex: "#3f6c9a",
		swatch: "bg-cat-blue",
		use: "category icons only",
		contrast: "5.2",
	},
	{
		name: "cat-plum",
		hex: "#7a4a7e",
		swatch: "bg-cat-plum",
		use: "category icons only",
		contrast: "6.4",
	},
	{
		name: "cat-slate",
		hex: "#4f6272",
		swatch: "bg-cat-slate",
		use: "category icons only",
		contrast: "6.0",
	},
	{
		name: "cat-ochre",
		hex: "#a87414",
		swatch: "bg-cat-ochre",
		use: "category icons only",
		contrast: "3.8",
	},
	{
		name: "cat-brown",
		hex: "#7a5230",
		swatch: "bg-cat-brown",
		use: "category icons only",
		contrast: "6.4",
	},
] as const;

export const CATEGORY_COLORS = COLOR_TOKENS.filter((t) =>
	t.name.startsWith("cat-"),
).map((t) => t.name);

// Each type role with its real classes (DESIGN.md "Type roles").
export const TYPE_ROLES = [
	{
		role: "Page title / month",
		classes: "font-serif text-5xl font-semibold tracking-tight",
		sample: "September",
	},
	{
		role: "Section title",
		classes: "font-serif text-3xl font-semibold",
		sample: "Categories",
	},
	{
		role: "Headline amount",
		classes: "font-serif text-6xl font-semibold tracking-tight lg:text-7xl",
		sample: "$1,284",
	},
	{
		role: "Sheet title and amount",
		classes: "font-serif text-4xl font-semibold tracking-tight",
		sample: "Local Bakery",
	},
	{
		role: "Status sentence",
		classes: "font-serif text-lg italic",
		sample: "You're on track, with $1,284 safe to spend.",
	},
	{
		role: "Body / rows",
		classes: "text-lg tabular-nums",
		sample: "Groceries  $412 of $600",
	},
	{
		role: "Secondary",
		classes: "text-muted",
		sample: "Picked by Jev · 92% sure",
	},
] as const;

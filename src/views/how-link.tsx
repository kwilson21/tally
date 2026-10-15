import { KeysDetails } from "./keys";

const NAMES = {
	budget: "the budget",
	transactions: "transactions",
	bills: "bills",
	categorization: "categories",
	exclusions: "excluding",
	trends: "trends",
} as const;

/** A small "How this works" link from a screen to its section of How Tally works (spec §9). */
export function HowLink({ section }: { section: keyof typeof NAMES }) {
	return (
		<a
			href={`/how-it-works#${section}`}
			// Distinct names for links to different places (WCAG 2.4.4); the visible text stays in the name.
			aria-label={`How this works: ${NAMES[section]}`}
			class="inline-flex min-h-11 items-center text-sm"
		>
			How this works
		</a>
	);
}

/**
 * A screen's How this works at the foot of its page, under a short rule, after the page's last content (P124 A, decision
 * 111). Under it, on desktop, the keys' details (decision 118), unless `keys` is off: a sheet's foot has none. Below lg,
 * More's last row lists the keys instead.
 */
export function HowFoot({
	section,
	keys = true,
}: {
	section: keyof typeof NAMES;
	keys?: boolean;
}) {
	return (
		<>
			<div class="mt-8">
				<div class="w-12 border-t border-muted" />
				<div class="mt-2">
					<HowLink section={section} />
				</div>
			</div>
			{keys && (
				<div class="mt-2 hidden lg:block">
					<KeysDetails />
				</div>
			)}
		</>
	);
}

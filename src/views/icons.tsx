import type { Child } from "hono/jsx";

// Paths from Lucide (https://lucide.dev), ISC License. Copied, not a dependency.
const PATHS = {
	home: (
		<>
			<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
			<path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		</>
	),
	list: (
		<>
			<path d="M3 5h.01" />
			<path d="M3 12h.01" />
			<path d="M3 19h.01" />
			<path d="M8 5h13" />
			<path d="M8 12h13" />
			<path d="M8 19h13" />
		</>
	),
	bills: (
		<>
			<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
			<path d="M14 2v5a1 1 0 0 0 1 1h5" />
			<path d="M10 9H8" />
			<path d="M16 13H8" />
			<path d="M16 17H8" />
		</>
	),
	trends: (
		<>
			<path d="M3 3v16a2 2 0 0 0 2 2h16" />
			<path d="M18 17V9" />
			<path d="M13 17V5" />
			<path d="M8 17v-3" />
		</>
	),
	more: (
		<>
			<circle cx="12" cy="12" r="1" />
			<circle cx="19" cy="12" r="1" />
			<circle cx="5" cy="12" r="1" />
		</>
	),
	accounts: (
		<>
			<rect width="20" height="14" x="2" y="5" rx="2" />
			<line x1="2" x2="22" y1="10" y2="10" />
			<path d="M6 14h2" />
		</>
	),
	documents: (
		<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
	),
	settings: (
		<>
			<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
			<circle cx="12" cy="12" r="3" />
		</>
	),
	groceries: (
		<>
			<path d="m15 11-1 9" />
			<path d="m19 11-4-7" />
			<path d="M2 11h20" />
			<path d="m3.5 11 1.6 7.4a2 2 0 0 0 2 1.6h9.8a2 2 0 0 0 2-1.6l1.7-7.4" />
			<path d="M4.5 15.5h15" />
			<path d="m5 11 4-7" />
			<path d="m9 11 1 9" />
		</>
	),
	"eating-out": (
		<>
			<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
			<path d="M7 2v20" />
			<path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
		</>
	),
	gas: (
		<>
			<path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0v-6.998a2 2 0 0 0-.59-1.42L18 5" />
			<path d="M14 21V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v16" />
			<path d="M2 21h13" />
			<path d="M3 9h11" />
		</>
	),
	kids: (
		<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />
	),
	household: (
		<>
			<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" />
			<path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		</>
	),
	income: (
		<>
			<path d="M12 5v14" />
			<path d="m19 12-7 7-7-7" />
		</>
	),
	transfer: (
		<>
			<path d="M8 3 4 7l4 4" />
			<path d="M4 7h16" />
			<path d="m16 21 4-4-4-4" />
			<path d="M20 17H4" />
		</>
	),
	alert: (
		<>
			<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
			<path d="M12 9v4" />
			<path d="M12 17h.01" />
		</>
	),
	chevron: <path d="m9 18 6-6-6-6" />,
	close: (
		<>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</>
	),
	search: (
		<>
			<path d="m21 21-4.34-4.34" />
			<circle cx="11" cy="11" r="8" />
		</>
	),
	"chevron-right": <path d="m9 18 6-6-6-6" />,
	check: <path d="M20 6 9 17l-5-5" />,
	"circle-dashed": (
		<>
			<path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
			<path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
			<path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
			<path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
			<path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" />
			<path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
			<path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
			<path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />
		</>
	),
} satisfies Record<string, Child>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

type IconProps = { name: IconName; class?: string };

export function Icon({ name, class: className = "size-6" }: IconProps) {
	return (
		<svg
			class={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="1.75"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			{PATHS[name]}
		</svg>
	);
}

import { Icon, type IconName } from "./icons";

export type NavKey =
	| "home"
	| "transactions"
	| "bills"
	| "trends"
	| "accounts"
	| "documents"
	| "settings"
	| "more";

type NavItem = { key: NavKey; label: string; href: string; icon: IconName };

// Desktop sidebar shows every destination; phone tabs show four plus "More".
export const SIDEBAR_ITEMS: NavItem[] = [
	{ key: "home", label: "Home", href: "/", icon: "home" },
	{
		key: "transactions",
		label: "Transactions",
		href: "/transactions",
		icon: "list",
	},
	{ key: "bills", label: "Bills", href: "/bills", icon: "bills" },
	{ key: "trends", label: "Trends", href: "/trends", icon: "trends" },
	{ key: "accounts", label: "Accounts", href: "/accounts", icon: "accounts" },
	{
		key: "documents",
		label: "Documents",
		href: "/documents",
		icon: "documents",
	},
	{ key: "settings", label: "Settings", href: "/settings", icon: "settings" },
];

const TAB_ITEMS: NavItem[] = [
	...SIDEBAR_ITEMS.slice(0, 4),
	{ key: "more", label: "More", href: "/more", icon: "more" },
];

const MORE_KEYS: NavKey[] = ["accounts", "documents", "settings", "more"];

function isCurrent(item: NavItem, active?: NavKey) {
	if (item.key === "more")
		return active !== undefined && MORE_KEYS.includes(active);
	return item.key === active;
}

export function Sidebar({ active }: { active?: NavKey }) {
	return (
		<nav aria-label="Main" class="hidden lg:block">
			<ul class="flex flex-col gap-1">
				{SIDEBAR_ITEMS.map((item) => (
					<li>
						<a
							href={item.href}
							aria-current={isCurrent(item, active) ? "page" : undefined}
							class="flex min-h-11 items-center gap-3 rounded-control px-2 text-lg text-ink no-underline aria-[current=page]:text-accent"
						>
							<Icon name={item.icon} />
							{item.label}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}

export function BottomTabs({ active }: { active?: NavKey }) {
	return (
		<nav
			aria-label="Tabs"
			class="fixed inset-x-0 bottom-0 border-t border-rule bg-paper lg:hidden"
		>
			<ul class="grid grid-cols-5">
				{TAB_ITEMS.map((item) => (
					<li>
						<a
							href={item.href}
							aria-current={isCurrent(item, active) ? "page" : undefined}
							class="flex min-h-14 flex-col items-center justify-center gap-1 text-xs text-muted no-underline aria-[current=page]:text-accent"
						>
							<Icon name={item.icon} />
							{item.label}
						</a>
					</li>
				))}
			</ul>
		</nav>
	);
}

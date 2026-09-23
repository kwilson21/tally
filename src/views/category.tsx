import { ICON_NAMES, Icon, type IconName } from "./icons";

// Literal class names so Tailwind generates them. Keys are the color tokens stored on categories.
const COLOR_CLASS: Record<string, string> = {
	"cat-blue": "text-cat-blue",
	"cat-plum": "text-cat-plum",
	"cat-slate": "text-cat-slate",
	"cat-ochre": "text-cat-ochre",
	"cat-brown": "text-cat-brown",
};

function iconName(icon: string): IconName {
	return (ICON_NAMES as string[]).includes(icon) ? (icon as IconName) : "list";
}

/** A category's line icon, drawn in its color token. */
export function CategoryIcon({ icon, color }: { icon: string; color: string }) {
	return (
		<span class={`shrink-0 ${COLOR_CLASS[color] ?? "text-muted"}`}>
			<Icon name={iconName(icon)} class="size-7" />
		</span>
	);
}

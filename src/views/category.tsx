import { ICON_NAMES, Icon, type IconName } from "./icons";

// Literal class names so Tailwind generates them. Keys are the color tokens stored on categories.
const COLOR_CLASS = new Map<string, string>([
	["cat-blue", "text-cat-blue"],
	["cat-plum", "text-cat-plum"],
	["cat-slate", "text-cat-slate"],
	["cat-ochre", "text-cat-ochre"],
	["cat-brown", "text-cat-brown"],
]);

function isIconName(value: string): value is IconName {
	return ICON_NAMES.some((name) => name === value);
}

function iconName(icon: string): IconName {
	return isIconName(icon) ? icon : "list";
}

/** A category's line icon, drawn in its color token. */
export function CategoryIcon({ icon, color }: { icon: string; color: string }) {
	return (
		<span class={`shrink-0 ${COLOR_CLASS.get(color) ?? "text-muted"}`}>
			<Icon name={iconName(icon)} class="size-7" />
		</span>
	);
}

import type { Context } from "hono";

/**
 * The address a request was asked for: its path and query, which a person can load again. A page passes it as its
 * currentPath, so the keys sheet (?keys) opens over that same page.
 */
export function addressOf(c: Context): string {
	return c.req.path + new URL(c.req.url).search;
}

/**
 * A path for a link on this site: leading slashes become one, and a backslash, tab, LF or CR (which a browser reads as
 * another host) gives "/".
 */
export function sitePath(path: string): string {
	return /[\\\t\n\r]/.test(path) ? "/" : path.replace(/^\/+/, "/");
}

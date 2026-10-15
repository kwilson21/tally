/**
 * The value of an HX-Trigger header for a toast and an announcement. A header must be ASCII, so every character above
 * 0x7E is written as a backslash-u escape of four hex digits (a character outside the Basic Multilingual Plane becomes two, as its UTF-16
 * units). JSON reads the escapes back to the same words, so htmx and public/js/toast.js show the same text (#521).
 */
export function hxTrigger(trigger: Record<string, unknown>): string {
	// JSON.stringify has already escaped the control characters below 0x20, so what is left outside " " to "~" is non-ASCII.
	return JSON.stringify(trigger).replace(
		/[^\x20-\x7e]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

// The time zones Settings offers for the household (spec §8.5, decision 72, P35 A): the six US zones
// by their everyday names, then the other zones the drawing lists. A zone is saved as its IANA name
// ("America/Chicago"), which is what src/dates.ts hands to Intl; the name people read is the label.

type Zone = readonly [zone: string, label: string];

/** The US zones, Eastern first (decision 67: the household starts in Eastern). */
export const US_ZONES: readonly Zone[] = [
	["America/New_York", "Eastern"],
	["America/Chicago", "Central"],
	["America/Denver", "Mountain"],
	["America/Los_Angeles", "Pacific"],
	["America/Anchorage", "Alaska"],
	["Pacific/Honolulu", "Hawaii"],
];

/** The select's "Other time zones" group. */
export const OTHER_ZONES: readonly Zone[] = [
	["America/Phoenix", "Phoenix"],
	["America/Puerto_Rico", "Puerto Rico"],
	["America/Toronto", "Toronto"],
	["Europe/London", "London"],
];

const LABELS = new Map<string, string>([...US_ZONES, ...OTHER_ZONES]);

/** The words Settings shows for a zone: "Eastern", "Puerto Rico". One that isn't offered gets its city. */
export function zoneLabel(zone: string): string {
	return (
		LABELS.get(zone) ?? (zone.split("/").at(-1) ?? zone).replaceAll("_", " ")
	);
}

/** Only a zone the select offers is saved; the match is exact, so no other spelling gets in. */
export function isSupportedZone(zone: string): boolean {
	return LABELS.has(zone);
}

export const TIME_ZONE_ERROR = "Choose a time zone from the list.";

type Parsed = { ok: true; zone: string } | { ok: false; error: string };

/** The posted `time_zone`, if it is one the select offers. */
export function parseTimeZone(form: FormData): Parsed {
	const zone = form.get("time_zone");
	return typeof zone === "string" && isSupportedZone(zone)
		? { ok: true, zone }
		: { ok: false, error: TIME_ZONE_ERROR };
}

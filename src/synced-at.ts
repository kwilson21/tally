/**
 * Human wording for when a bank last completed a sync, or null when there's nothing true to say:
 * no time yet (banks linked before sync times were kept have none) or one it can't read. UTC.
 */
export function syncedAtLabel(
	lastSyncedAt: string | null,
	now: Date = new Date(),
): string | null {
	if (lastSyncedAt === null) return null;
	const then = new Date(`${lastSyncedAt.replace(" ", "T")}Z`);
	if (Number.isNaN(then.getTime())) return null;
	const seconds = Math.max(
		0,
		Math.floor((now.getTime() - then.getTime()) / 1000),
	);
	if (seconds < 60) return "Synced just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60)
		return `Synced ${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24)
		return `Synced ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
	if (hours < 48) return "Synced 1 day ago";
	return `Synced ${then.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	})}`;
}

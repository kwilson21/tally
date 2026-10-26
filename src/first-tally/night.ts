// The 09:00 run's night (spec §7, decision 139): the UTC day the run's clock reads, which names the night its sorting
// instance is started for (params.night). Setup is done at the budgets stroke (decision 148), so the first night's counts
// are no longer kept.

/** The UTC date a run's clock reads: the night's identity, the cron's own day (not a household day). */
export const utcDay = (ms: number): string =>
	new Date(ms).toISOString().slice(0, 10);

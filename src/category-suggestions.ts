export type NoneFit = {
	id: number;
	theme: string;
	merchant: string;
	merchantKey: string;
};
export const MIN_GROUP = 3;
export const MAX_MERCHANTS_SENT = 10;

export function groupNoneFit(rows: NoneFit[]) {
	const groups = new Map<string, NoneFit[]>();
	for (const row of rows) {
		const group = groups.get(row.theme);
		if (group) group.push(row);
		else groups.set(row.theme, [row]);
	}
	return [...groups.entries()]
		.filter(([, group]) => group.length >= MIN_GROUP)
		.sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b, "en"))
		.map(([theme, group]) => {
			const counts = new Map<string, { count: number; merchant: string }>();
			for (const row of group) {
				const found = counts.get(row.merchantKey);
				counts.set(row.merchantKey, {
					count: (found?.count ?? 0) + 1,
					merchant: row.merchant,
				});
			}
			return {
				theme,
				ids: group.map((row) => row.id).sort((a, b) => a - b),
				merchants: [...counts.values()]
					.sort(
						(a, b) =>
							b.count - a.count || a.merchant.localeCompare(b.merchant, "en"),
					)
					.slice(0, MAX_MERCHANTS_SENT)
					.map(({ merchant }) => merchant),
			};
		});
}

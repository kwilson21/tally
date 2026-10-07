export type ForecastInput = {
	day: number;
	daysInMonth: number;
	totalBudgetCents: number;
	spentCents: number;
	everydayCents: number;
	billPaymentsCents: number;
	refundsCents: number;
	billsStillDueCents: number;
};

export const FORECAST_START_DAY = 7;

/** The month-end estimate in integer cents; signed refunds reduce spending and never repeat in the projection. */
export function forecastMonth(input: ForecastInput) {
	const projectedCents = Math.round(
		(input.everydayCents * (input.daysInMonth - input.day)) / input.day,
	);
	const endCents = input.spentCents + input.billsStillDueCents + projectedCents;
	const differenceCents = input.totalBudgetCents - endCents;
	const visible = input.day >= FORECAST_START_DAY;
	return differenceCents >= 0
		? {
				endCents,
				underCents: Math.floor(differenceCents / 100) * 100,
				visible,
			}
		: {
				endCents,
				overCents: Math.ceil(-differenceCents / 100) * 100,
				visible,
			};
}

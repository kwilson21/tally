export type ForecastInput = {
	day: number;
	daysInMonth: number;
	totalBudgetCents: number;
	spentCents: number;
	billPaymentsCents: number;
	planPaymentsCents: number;
	refundsCents: number;
	billsStillDueCents: number;
};

/** The month-end estimate in integer cents; refunds reduce spending but never repeat in the projection. */
export function forecastMonth(input: ForecastInput) {
	const everydayCents =
		input.spentCents -
		input.billPaymentsCents -
		input.planPaymentsCents +
		input.refundsCents;
	const projectedCents = Math.round(
		(everydayCents * (input.daysInMonth - input.day)) / input.day,
	);
	const endCents = input.spentCents + input.billsStillDueCents + projectedCents;
	const differenceCents = input.totalBudgetCents - endCents;
	const visible = input.day >= 3;
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

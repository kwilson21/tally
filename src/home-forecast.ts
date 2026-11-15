import { ceilToDollars, floorToDollars } from "./money";

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

/**
 * The month-end estimate in integer cents; signed refunds reduce spending and never repeat in the projection.
 * An under amount rounds down and an over amount rounds up on purpose, so the forecast never understates overspend
 * or overstates room; the two directions are not one rule.
 */
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
				underCents: floorToDollars(differenceCents),
				visible,
			}
		: {
				endCents,
				overCents: ceilToDollars(-differenceCents),
				visible,
			};
}

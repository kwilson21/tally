/** A whole confidence (1) in basis points. The review queue's SQL reads it too, so the two can't drift apart. */
export const BASIS_POINTS = 10_000;

/** Confidence comparisons floor to hundredths of a percent, with no rounding across a threshold. */
export const confidenceBasisPoints = (confidence: number) =>
	Math.floor(confidence * BASIS_POINTS);

export const meetsConfidenceThreshold = (
	confidence: number,
	threshold: number,
) => confidenceBasisPoints(confidence) >= confidenceBasisPoints(threshold);

/** Rounded only to print a human-readable whole-percent label. */
export const confidencePercent = (confidence: number) =>
	Math.round(confidence * 100);

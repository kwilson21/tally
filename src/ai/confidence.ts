/** Confidence comparisons floor to hundredths of a percent, with no rounding across a threshold. */
export const confidenceBasisPoints = (confidence: number) =>
	Math.floor(confidence * 10_000);

export const meetsConfidenceThreshold = (
	confidence: number,
	threshold: number,
) => confidenceBasisPoints(confidence) >= confidenceBasisPoints(threshold);

/** Rounded only to print a human-readable whole-percent label. */
export const confidencePercent = (confidence: number) =>
	Math.round(confidence * 100);

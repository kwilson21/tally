/** Confidence comparisons use whole percent so decimal representation cannot move a boundary. */
export const confidencePercent = (confidence: number) =>
	Math.round(confidence * 100);

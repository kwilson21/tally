// Retries for screenshots that Chromium fails to take, and the slices a page too tall for one
// capture is taken in (#580). Pure: the page calls are passed in, so test/capture.test.ts fakes them.

/** Full-page tries before a page is taken in slices instead. */
export const ATTEMPTS = 3;
/** Height of one slice in CSS pixels. Each slice is its own, much smaller, capture. */
export const SLICE_HEIGHT = 16000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `capture`, and if it fails, waits a moment and tries again. When every try fails, the page
 * is taken by `fallback` instead, so it is kept rather than dropped. Each failed try is logged
 * with the page's label and its attempt number.
 * @template T
 * @param {{ label: string, capture: () => Promise<T>, fallback: () => Promise<T>, attempts?: number, wait?: (ms: number) => Promise<void>, log?: (line: string) => void }} options
 * @returns {Promise<T>}
 */
export async function captureWithRetries({
	label,
	capture,
	fallback,
	attempts = ATTEMPTS,
	wait = pause,
	log = console.warn,
}) {
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await capture();
		} catch (error) {
			log(
				`${label}: attempt ${attempt} of ${attempts} failed (${error.message}).`,
			);
			if (attempt < attempts) await wait(attempt * 1000);
		}
	}
	log(`${label}: every full-page try failed, so it is taken in slices.`);
	return fallback();
}

/**
 * The slices a page `height` CSS pixels tall is taken in, top to bottom, each at most
 * `sliceHeight` tall. A page shorter than one slice is a single slice.
 * @param {number} height
 * @param {number} [sliceHeight]
 * @returns {{ y: number, height: number }[]}
 */
export function sliceBands(height, sliceHeight = SLICE_HEIGHT) {
	const bands = [];
	for (let y = 0; y < height; y += sliceHeight)
		bands.push({ y, height: Math.min(sliceHeight, height - y) });
	return bands;
}

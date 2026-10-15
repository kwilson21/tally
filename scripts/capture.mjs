// Retries for screenshots that Chromium fails to take, and the slices a page too tall for one
// capture is taken in (#580). Pure: the page calls are passed in, so test/capture.test.ts fakes them.

/** Full-page tries before a page is taken in slices instead. */
export const ATTEMPTS = 3;
/** Height of one slice in CSS pixels. Each slice is its own, much smaller, capture. */
export const SLICE_HEIGHT = 16000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `capture`, and if it fails, waits a moment and tries again. Each failed try is logged with
 * the label and its attempt number. When every try fails, `fallback` takes the shot instead, so it
 * is kept rather than dropped; without a `fallback`, the last error is thrown.
 * @template T
 * @param {{ label: string, capture: () => Promise<T>, fallback?: () => Promise<T>, attempts?: number, wait?: (ms: number) => Promise<void>, log?: (line: string) => void }} options
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
	let last;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await capture();
		} catch (error) {
			last = error;
			log(
				`${label}: attempt ${attempt} of ${attempts} failed (${error.message}).`,
			);
			if (attempt < attempts) await wait(attempt * 1000);
		}
	}
	if (!fallback) throw last;
	log(`${label}: every full-page try failed, so it is taken in slices.`);
	return fallback();
}

/**
 * Takes each slice of a page, in band order, one after another. A slice that fails is retried the
 * same way a whole page is (see captureWithRetries), so one bad slice doesn't cost the page.
 * @template T
 * @param {{ label: string, bands: { y: number, height: number }[], capture: (band: { y: number, height: number }) => Promise<T>, attempts?: number, wait?: (ms: number) => Promise<void>, log?: (line: string) => void }} options
 * @returns {Promise<T[]>}
 */
export async function captureSlices({
	label,
	bands,
	capture,
	attempts,
	wait,
	log,
}) {
	const shots = [];
	for (const [i, band] of bands.entries())
		shots.push(
			await captureWithRetries({
				label: `${label}, slice ${i + 1} of ${bands.length}`,
				capture: () => capture(band),
				attempts,
				wait,
				log,
			}),
		);
	return shots;
}

/**
 * Makes `shoot()` for one page. A page taller than one slice (`height`, in CSS pixels) is taken in
 * slices from the start: Chromium's whole-page capture repeats the page's top past row 16384, and
 * succeeds while doing it, so a whole try would keep a wrong image. Any other page is taken whole,
 * retrying, and once every whole-page try has failed it is taken in slices. Either way, after the
 * first slices the stability retakes don't retry a page that can only be sliced.
 * @template T
 * @param {{ label: string, height?: number, whole: () => Promise<T>, slices: () => Promise<T>, attempts?: number, wait?: (ms: number) => Promise<void>, log?: (line: string) => void }} options
 * @returns {() => Promise<T>}
 */
export function pageShooter({
	label,
	height,
	whole,
	slices,
	attempts,
	wait,
	log,
}) {
	let sliced = height > SLICE_HEIGHT;
	return () => {
		if (sliced) return slices();
		return captureWithRetries({
			label,
			capture: whole,
			fallback: async () => {
				sliced = true;
				return slices();
			},
			attempts,
			wait,
			log,
		});
	};
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

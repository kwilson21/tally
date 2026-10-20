// PNGs for test/png.test.ts and test/pr-body.test.ts (#753). Made with Python's zlib, with real CRCs,
// and checked against Pillow. Each pixel list below is row by row, x inside y.

/** 5×5 RGB. Rows use filter types 0, 1, 2, 3, 4 in order; the zlib stream is split over two IDAT chunks. */
export const FILTERED =
	"iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAIAAAACDbGyAAAAJ0lEQVR42mNgOMFgqsme1SUz/7X9FZ8CRvmr3KaJ7KaJoqaJyqaJhkzyvIoviOukAAAAJ0lEQVTIiNmuzldru7yWuZrWdt1V5iYs8ry+8rzs8ryi8rzKpryGABtwEUv9bsRbAAAAAElFTkSuQmCC";

/** The same 5×5 RGB pixels as FILTERED, with every row filter 0, so the bytes differ. */
export const PLAIN =
	"iVBORw0KGgoAAAANSUhEUgAAAAUAAAAFCAIAAAACDbGyAAAAW0lEQVR42gFQAK//AADIADUpB2qKHJ/rP9RMcAAf1QtUNhKJlye++ErzWXsAPuIsc0MzqKRI3QVrEmacAF3vY5JQasexf/wSojFz0wB8/LCxXbfmvswbH+9QgCD+3CL5V1Y+7AAAAABJRU5ErkJggg==";

/** 2×2 RGBA. Row 0 is Paeth, row 1 is Average. */
export const ALPHA =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGklEQVR42mNh+MX6P0qQ4QizRm11g2OnzSMAOV4GvdgW5R8AAAAASUVORK5CYII=";

/** 2×2 RGB. Filters 0 then 4 (Paeth); pins Paeth's tie-break order. */
export const TIE =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGNgYmRiZmZm+ff/HycbJwAPzgMmdhpmmwAAAABJRU5ErkJggg==";

/** Lays out pixels row by row, each pixel's channel values from `at`. */
function pixels(
	width: number,
	height: number,
	at: (x: number, y: number) => number[],
): number[] {
	const out: number[] = [];
	for (let y = 0; y < height; y++)
		for (let x = 0; x < width; x++) out.push(...at(x, y));
	return out;
}

/** The pixels FILTERED and PLAIN hold: 5×5 RGB. */
export const RGB_PIXELS = pixels(5, 5, (x, y) => [
	(x * 53 + y * 31) % 256,
	(x * 97 + y * 13 + 200) % 256,
	(x * x * 7 + y * y * 11) % 256,
]);

/** The pixels ALPHA holds: 2×2 RGBA. */
export const RGBA_PIXELS = pixels(2, 2, (x, y) => [
	(x * 90 + y * 40) % 256,
	(x * 17 + 250) % 256,
	(y * 120 + 5) % 256,
	255 - x * 60,
]);

/** Decodes base64 into bytes. */
export function fromBase64(text: string): Uint8Array {
	return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

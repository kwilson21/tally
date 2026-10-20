// Reads the pixels out of a PNG that CI took (#753). Uses only DecompressionStream, which Node and the
// Workers runtime both have, so there is no zlib import and no dependency.

/**
 * A decoded picture: rows from top to bottom, each pixel's channels in order, filters undone.
 * @typedef {{ width: number, height: number, channels: number, data: Uint8Array }} Png
 */

/** What readPng throws for bytes that aren't a PNG at all. pr-body.mjs checks for it. */
export const NOT_A_PNG = "Not a PNG file.";
const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const TRUNCATED = "Truncated PNG chunk.";
const NO_HEADER_OR_DATA = "PNG has no IHDR or no IDAT.";
const UNSUPPORTED = "Only 8-bit RGB or RGBA PNGs are read.";
const INTERLACED = "Interlaced PNGs aren't read.";
const UNKNOWN_FILTER = "Unknown PNG filter type.";
const DAMAGED = "The PNG's picture data is damaged.";

/**
 * The pixels of a PNG, with its filters undone. Only 8-bit RGB (3 channels) and RGBA (4), not
 * interlaced, are read; any other PNG throws an Error that says why. The CRCs aren't checked.
 * @param {Uint8Array} bytes
 * @returns {Promise<Png>}
 */
export async function readPng(bytes) {
	for (let i = 0; i < SIGNATURE.length; i++)
		if (bytes[i] !== SIGNATURE[i]) throw new Error(NOT_A_PNG);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let header = null;
	const idats = [];
	let at = SIGNATURE.length;
	while (at < bytes.length) {
		if (at + 8 > bytes.length) throw new Error(TRUNCATED);
		const length = view.getUint32(at);
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
		const start = at + 8;
		const end = start + length;
		if (end + 4 > bytes.length) throw new Error(TRUNCATED);
		if (type === "IHDR" && length === 13)
			header = {
				width: view.getUint32(start),
				height: view.getUint32(start + 4),
				bitDepth: bytes[start + 8],
				colourType: bytes[start + 9],
				compression: bytes[start + 10],
				filterMethod: bytes[start + 11],
				interlace: bytes[start + 12],
			};
		else if (type === "IDAT") idats.push(bytes.subarray(start, end));
		else if (type === "IEND") break;
		at = end + 4;
	}
	if (!header || idats.length === 0) throw new Error(NO_HEADER_OR_DATA);

	const { width, height, bitDepth, colourType, compression, filterMethod } =
		header;
	if (
		bitDepth !== 8 ||
		(colourType !== 2 && colourType !== 6) ||
		compression !== 0 ||
		filterMethod !== 0
	)
		throw new Error(UNSUPPORTED);
	if (header.interlace !== 0) throw new Error(INTERLACED);
	const channels = colourType === 2 ? 3 : 4;

	let raw;
	try {
		raw = new Uint8Array(
			await new Response(
				new Blob(idats)
					.stream()
					.pipeThrough(new DecompressionStream("deflate")),
			).arrayBuffer(),
		);
	} catch (error) {
		if (error instanceof TypeError) throw new Error(DAMAGED);
		throw error;
	}

	// Each row is one filter-type byte, then its bytes.
	const stride = width * channels;
	if (raw.length !== height * (stride + 1)) throw new Error(DAMAGED);
	const data = new Uint8Array(height * stride);
	for (let y = 0; y < height; y++) {
		const line = y * (stride + 1);
		const row = y * stride;
		for (let x = 0; x < stride; x++) {
			const left = x >= channels ? data[row + x - channels] : 0;
			const up = y > 0 ? data[row - stride + x] : 0;
			const upLeft =
				x >= channels && y > 0 ? data[row - stride + x - channels] : 0;
			// Uint8Array stores the sum mod 256, as the PNG spec asks.
			data[row + x] = undoFilter(
				raw[line],
				raw[line + 1 + x],
				left,
				up,
				upLeft,
			);
		}
	}
	return { width, height, channels, data };
}

/**
 * One byte of a scanline with its filter undone. `x` is the stored byte; `a`, `b` and `c` are the
 * reconstructed bytes one pixel to the left, directly above, and above-left (0 where there is none).
 * @param {number} filter
 * @param {number} x
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
function undoFilter(filter, x, a, b, c) {
	switch (filter) {
		case 0:
			return x;
		case 1:
			return x + a;
		case 2:
			return x + b;
		case 3:
			return x + Math.floor((a + b) / 2);
		case 4:
			return x + paeth(a, b, c);
		default:
			throw new Error(UNKNOWN_FILTER);
	}
}

/**
 * The Paeth predictor from the PNG spec: the nearest of a, b and c to a + b - c. Ties go to a, then
 * b, in that order, which is required.
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	if (pb <= pc) return b;
	return c;
}

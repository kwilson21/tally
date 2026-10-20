import { describe, expect, it } from "vitest";
import { readPng } from "../scripts/png.mjs";
import {
	ALPHA,
	FILTERED,
	fromBase64,
	PLAIN,
	RGB_PIXELS,
	RGBA_PIXELS,
	TIE,
} from "./png-fixtures";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A chunk: its length, its type, its data, and a zero CRC (readPng doesn't check CRCs). */
function chunk(type: string, data: number[] = []): number[] {
	const length = new DataView(new ArrayBuffer(4));
	length.setUint32(0, data.length);
	return [
		...new Uint8Array(length.buffer),
		...Array.from(type, (c) => c.charCodeAt(0)),
		...data,
		0,
		0,
		0,
		0,
	];
}

/** IHDR's data for a non-interlaced 8-bit picture of the given size and colour type. */
function header(width: number, height: number, colourType: number): number[] {
	const size = new DataView(new ArrayBuffer(8));
	size.setUint32(0, width);
	size.setUint32(4, height);
	return [...new Uint8Array(size.buffer), 8, colourType, 0, 0, 0];
}

/** A zlib stream of `bytes`, made by the runtime's own CompressionStream. */
async function deflate(bytes: number[]): Promise<number[]> {
	const stream = new Blob([new Uint8Array(bytes)])
		.stream()
		.pipeThrough(new CompressionStream("deflate"));
	return Array.from(new Uint8Array(await new Response(stream).arrayBuffer()));
}

/** A PNG made of the signature and the given chunks. */
function png(...chunks: number[][]): Uint8Array {
	return new Uint8Array([...SIGNATURE, ...chunks.flat()]);
}

describe("readPng", () => {
	it("decodes every filter type, with the picture split over two IDAT chunks", async () => {
		const decoded = await readPng(fromBase64(FILTERED));
		expect(decoded.width).toBe(5);
		expect(decoded.height).toBe(5);
		expect(decoded.channels).toBe(3);
		expect(Array.from(decoded.data)).toEqual(RGB_PIXELS);
	});

	it("decodes the same pixels from bytes filtered another way", async () => {
		const decoded = await readPng(fromBase64(PLAIN));
		expect(Array.from(decoded.data)).toEqual(RGB_PIXELS);
	});

	it("decodes RGBA with four channels", async () => {
		const decoded = await readPng(fromBase64(ALPHA));
		expect(decoded.channels).toBe(4);
		expect(Array.from(decoded.data)).toEqual(RGBA_PIXELS);
	});

	it("undoes Paeth with the spec's tie-break order", async () => {
		const decoded = await readPng(fromBase64(TIE));
		expect(Array.from(decoded.data)).toEqual([
			2, 1, 2, 3, 3, 3, 0, 0, 0, 9, 9, 9,
		]);
	});

	it("reads a PNG that sits at an offset inside a bigger buffer", async () => {
		const bytes = fromBase64(FILTERED);
		const big = new Uint8Array(bytes.length + 40);
		big.set(bytes, 17);
		const decoded = await readPng(big.subarray(17, 17 + bytes.length));
		expect(Array.from(decoded.data)).toEqual(RGB_PIXELS);
	});

	it("rejects bytes that aren't a PNG", async () => {
		await expect(
			readPng(new TextEncoder().encode("not a png")),
		).rejects.toThrow("Not a PNG file.");
	});

	it("rejects a chunk that runs past the end", async () => {
		await expect(readPng(fromBase64(FILTERED).subarray(0, 50))).rejects.toThrow(
			"Truncated PNG chunk.",
		);
	});

	it("rejects a PNG with no IHDR, or with no IDAT", async () => {
		await expect(readPng(png(chunk("IEND")))).rejects.toThrow(
			"PNG has no IHDR or no IDAT.",
		);
		await expect(
			readPng(png(chunk("IHDR", header(1, 1, 2)), chunk("IEND"))),
		).rejects.toThrow("PNG has no IHDR or no IDAT.");
	});

	it("rejects an interlaced PNG", async () => {
		const bytes = fromBase64(FILTERED);
		bytes[28] = 1;
		await expect(readPng(bytes)).rejects.toThrow(
			"Interlaced PNGs aren't read.",
		);
	});

	it("rejects a 16-bit PNG", async () => {
		const bytes = fromBase64(FILTERED);
		bytes[24] = 16;
		await expect(readPng(bytes)).rejects.toThrow(
			"Only 8-bit RGB or RGBA PNGs are read.",
		);
	});

	it("rejects a colour type other than RGB or RGBA", async () => {
		const bytes = fromBase64(FILTERED);
		bytes[25] = 0;
		await expect(readPng(bytes)).rejects.toThrow(
			"Only 8-bit RGB or RGBA PNGs are read.",
		);
	});

	it("rejects a filter type it doesn't know", async () => {
		// One pixel: filter type 5, then its three bytes.
		const bytes = png(
			chunk("IHDR", header(1, 1, 2)),
			chunk("IDAT", await deflate([5, 1, 2, 3])),
			chunk("IEND"),
		);
		await expect(readPng(bytes)).rejects.toThrow("Unknown PNG filter type.");
	});

	it("rejects picture data that won't inflate", async () => {
		const bytes = png(
			chunk("IHDR", header(1, 1, 2)),
			chunk("IDAT", [1, 2, 3, 4, 5]),
			chunk("IEND"),
		);
		await expect(readPng(bytes)).rejects.toThrow(
			"The PNG's picture data is damaged.",
		);
	});

	it("rejects picture data of the wrong length", async () => {
		// One RGB pixel needs four bytes (filter type and three channels); this has three.
		const bytes = png(
			chunk("IHDR", header(1, 1, 2)),
			chunk("IDAT", await deflate([0, 1, 2])),
			chunk("IEND"),
		);
		await expect(readPng(bytes)).rejects.toThrow(
			"The PNG's picture data is damaged.",
		);
	});
});

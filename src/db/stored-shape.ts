import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { Json } from "../json";
// Checks for JSON that was stored as text and is read back as a type. A cast (`JSON.parse(text) as Run`) claims the
// shape without looking; these look, so a stored value of the wrong shape fails where it is read and not later, as a
// property of undefined somewhere else. The checks name what the code reads and ignore keys it does not, because SQL
// writers add keys to stored objects (`json_set`).

/** A check that narrows an unknown value to T. */
export type Guard<T> = (value: unknown) => value is T;

export const isNumber: Guard<number> = (value): value is number =>
	typeof value === "number" && Number.isFinite(value);

export const isString: Guard<string> = (value): value is string =>
	typeof value === "string";

export const isBoolean: Guard<boolean> = (value): value is boolean =>
	typeof value === "boolean";

const isObject = (value: unknown): value is { [key: string]: Json } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** The value is null, or passes `guard`. */
export const isNullable =
	<T>(guard: Guard<T>): Guard<T | null> =>
	(value): value is T | null =>
		value === null || guard(value);

/** The value is missing, or passes `guard`. For a key the type marks `?`. */
export const isOptional =
	<T>(guard: Guard<T>): Guard<T | undefined> =>
	(value): value is T | undefined =>
		value === undefined || guard(value);

export const isArrayOf =
	<T>(guard: Guard<T>): Guard<T[]> =>
	(value): value is T[] =>
		Array.isArray(value) && value.every(guard);

/** An object whose every value passes `guard` (keys are free). */
export const isRecordOf =
	<T>(guard: Guard<T>): Guard<Record<string, T>> =>
	(value): value is Record<string, T> =>
		isObject(value) && Object.values(value).every(guard);

/**
 * An object with a check for every key of T. Naming T means a key added to the type without a check is a compile error,
 * so the type and the check cannot drift apart. Keys the shape does not name are allowed.
 */
export const hasStoredFields =
	<T extends object>(fields: { [K in keyof T]-?: Guard<T[K]> }): Guard<T> =>
	(value): value is T =>
		isObject(value) &&
		Object.entries<Guard<unknown>>(fields).every(([key, guard]) =>
			guard(value[key]),
		);

/** The stored text as a T, or null when it is not JSON or is not shaped like T. The caller decides what null means. */
export function readStored<T>(text: string, guard: Guard<T>): T | null {
	let value: unknown;

	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}

	return guard(value) ? value : null;
}

/**
 * The stored text as the Schema's type, or null when it is not JSON or is not shaped like it: the Schema read beside the
 * guards above (decision 206). It checks the shape and gives the value as stored, so a key the Schema does not name stays
 * on it, as with readStored. Its answers match readStored's for the guard of the same shape (test/stored-json-read.test.ts).
 * resort-run.ts still reads through the guards: its guards move here when #963 lets that file change.
 */
export function readStoredWith<S extends Schema.Constraint>(
	schema: S,
	text: string,
): S["Type"] | null {
	const read = Schema.decodeUnknownResult(
		Schema.fromJsonString(Schema.Unknown),
	)(text);

	if (!Result.isSuccess(read)) return null;

	return Schema.is(schema)(read.success) ? read.success : null;
}

/**
 * The stored text as the Schema's type, given as stored. JSON.parse runs first, so text that is not JSON throws the
 * SyntaxError it always threw; the parsed value is then checked with `Schema.is`, and a value of the wrong shape is null.
 * Unlike readStoredWith, the two failures are told apart, so a read that must refuse bad data can throw on one and
 * not the other (#1120). Decoding would strip the keys the Schema does not name, so the value is returned as parsed.
 */
export function parseStoredWith<S extends Schema.Constraint>(
	schema: S,
	text: string,
): S["Type"] | null {
	const value: unknown = JSON.parse(text);

	return Schema.is(schema)(value) ? value : null;
}

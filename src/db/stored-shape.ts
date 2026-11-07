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

const isObject = (value: unknown): value is Record<string, unknown> =>
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
export const isShape =
	<T extends object>(shape: { [K in keyof T]-?: Guard<T[K]> }): Guard<T> =>
	(value): value is T =>
		isObject(value) &&
		Object.entries(shape).every(([key, guard]) =>
			(guard as Guard<unknown>)(value[key]),
		);

/** The stored text as a T. Throws, naming the record, when the text is not JSON or is not shaped like T. */
export function parseStored<T>(name: string, text: string, guard: Guard<T>): T {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${name} is not JSON`);
	}
	if (!guard(value))
		throw new Error(`${name} does not have the shape it is read as`);
	return value;
}

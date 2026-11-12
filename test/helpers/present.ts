// Checked reads for tests: each throws where a cast would have let a missing value through (decision 201).

/** `value`, or a thrown error when the test's setup did not produce it. */
export function present<Value>(value: Value | null | undefined): Value {
	if (value === null || value === undefined)
		throw new Error("expected a value the test set up, got none");

	return value;
}

/** The item at `index`, or a thrown error when the list is shorter than the test expects. */
export function itemAt<Item>(items: readonly Item[], index: number): Item {
	if (index < 0 || index >= items.length)
		throw new Error(
			`expected an item at ${index}, the list has ${items.length}`,
		);

	// SAFETY: the bounds check above proves the index holds an item of the list.
	return items[index] as Item;
}

/** True for a function: lets a D1 or statement proxy bind a forwarded method without a `typeof` at the call. */
export function isMethod(
	value: unknown,
): value is (...args: never[]) => object {
	return typeof value === "function";
}

/** True when `prop` names a member of `target`: lets a Proxy trap read `target[prop]` without a cast. */
export function isMemberOf<Target extends object>(
	target: Target,
	prop: PropertyKey,
): prop is keyof Target {
	return prop in target;
}

/** A Proxy's read of `target`'s member `prop`: a method is bound to `target`, anything else is returned as it is. */
export function forwardMember<Target extends object>(
	target: Target,
	prop: PropertyKey,
): Target[keyof Target] | ((...args: never[]) => object) | undefined {
	if (!isMemberOf(target, prop)) return undefined;

	const value = target[prop];

	return isMethod(value) ? value.bind(target) : value;
}

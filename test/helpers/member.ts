// A member of a database or statement as a test's proxy hands it on: a method bound to its target, anything else as it
// is. The proxies in the tests that run another write between a save's read and its batch (or refuse a batch) use it.

type Method = (...args: never[]) => void;

function isMember<Target extends object>(
	target: Target,
	property: PropertyKey,
): property is keyof Target {
	return property in target;
}

function isMethod(value: unknown): value is Method {
	return typeof value === "function";
}

export function member<Target extends object>(
	target: Target,
	property: PropertyKey,
): Target[keyof Target] | Method | undefined {
	if (!isMember(target, property)) return undefined;

	const value = target[property];

	return isMethod(value) ? value.bind(target) : value;
}

// Test doubles for the Worker's bindings. A test supplies only the members the code under test reads; a member
// it did not supply is missing at run time, so a call to it throws and the test fails. That is what makes each
// helper here honest, and it is the one place the claim is made (decision 201).

/** `base` with the given bindings and secrets replaced or added, typed as the Worker's `Env`. */
export function envWith<Overrides extends object>(
	base: Env,
	overrides: Overrides,
): Env & Overrides {
	return Object.assign({}, base, overrides);
}

type AiRun = (model: string, input: never) => Promise<object | string | null>;

/** A Workers AI binding that answers `run` with the given function and has nothing else. */
export function fakeAi<Run extends AiRun>(run: Run): Ai & { run: Run } {
	const ai = { run };

	// SAFETY: the code under test calls only `ai.run`; every other member of `Ai` is absent and throws if used.
	return ai as Ai & { run: Run };
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Response | Promise<Response>;

/** A function with fetch's call signature, typed as `fetch` for code that takes a `fetchImpl`. */
export function fakeFetch<Impl extends FetchLike>(
	impl: Impl,
): typeof fetch & Impl {
	// SAFETY: callers only call it; `fetch`'s extra static members are never read by the code under test.
	return impl as typeof fetch & Impl;
}

/** Only the given bindings, typed as the Worker's `Env`: for a test whose point is that nothing else is set. */
export function envOnly<Bindings extends object>(
	bindings: Bindings,
): Env & Bindings {
	// SAFETY: the code under test reads only the bindings the test lists; any other reads as undefined, which is
	// what such a test is checking.
	return bindings as Env & Bindings;
}

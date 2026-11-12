// The edge (decision 204): where a form field, a part of the address or stored text becomes a typed value, with Effect's
// Schema. Plain code reads through readAtEdge; rules inside the app take the typed value and never parse again.
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";

/** A decode that reads `text` into a value with `read`, or refuses with the sentence `read` gives. */
export const readText = <T>(
	read: (text: string) => { value: T } | { say: string },
) =>
	SchemaGetter.transformEffect<T, string>((text, options) => {
		const answer = read(text);

		return "value" in answer
			? Effect.succeed(answer.value)
			: Effect.fail(
					new SchemaIssue.InvalidValue({ message: answer.say }, text, options),
				);
	});

/**
 * Reads a form field or a part of the address at the edge, from plain code: the typed value, or the sentence that says
 * why not. An edge whose words a person reads gives its own sentence (readText); any other failure's sentence is
 * Schema's, and is for a log only. A field or part that is not there is `undefined`, which no schema here reads.
 */
export function readAtEdge<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	input: string | undefined,
): { ok: true; value: S["Type"] } | { ok: false; say: string } {
	const read = Schema.decodeUnknownResult(schema)(input);

	return Result.isSuccess(read)
		? { ok: true, value: read.success }
		: { ok: false, say: read.failure.message };
}

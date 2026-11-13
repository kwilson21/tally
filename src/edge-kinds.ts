// Typed kinds shared by the edge readers (decision 206): the words the app reads from an address or a form, once, for every route.
import * as Schema from "effect/Schema";

/**
 * A row id from the address or a form: a whole number above zero, written with digits only. Fifteen digits at most, so
 * the largest id is 999999999999999, under Number.MAX_SAFE_INTEGER (9007199254740991), and a larger one is refused. Ids
 * come from our own pages, so no leading zero, sign, space, decimal point or exponent is written by the app.
 */
export const RowId = Schema.String.check(
	Schema.isPattern(/^[1-9]\d{0,14}$/),
).pipe(Schema.decodeTo(Schema.NumberFromString));

/**
 * A held Undo's name, from a form: 36 characters of hex digits and dashes, in either case, the shape a random UUID is
 * written in. Any other text is refused, and the route answers it as an Undo that has closed.
 */
export const Token = Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/i));

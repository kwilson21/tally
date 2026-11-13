// Typed kinds shared by the edge readers (decision 206): the words the app reads from an address or a form, once, for every route.
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { readText } from "./edge";

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

/**
 * A price in whole cents from a form (bills, #1006): digits only, at most fifteen, so the value stays a safe integer and
 * above the largest stored amount. Zeros in front are read as they always were ("0007" is 7). Any other text is refused.
 */
export const WholeCentsText = Schema.String.check(
	Schema.isPattern(/^\d{1,15}$/),
).pipe(Schema.decodeTo(Schema.NumberFromString));

/**
 * A held Not this one's Undo name, from a form (bills, #340): the payment's id written in digits as RowId reads them, a
 * dot, then a UUID in the shape Token takes. Decoded to the payment's id and the whole name, which is the token the Not
 * this one saved.
 */
export const UndoName = Schema.String.pipe(
	Schema.decodeTo(
		Schema.Struct({ transactionId: Schema.Number, token: Schema.String }),
		{
			decode: readText<{ transactionId: number; token: string }>((text) => {
				const pair = /^([1-9]\d{0,14})\.[0-9a-f-]{36}$/i.exec(text);

				return pair
					? { value: { transactionId: Number(pair[1]), token: text } }
					: { say: "That is not an Undo." };
			}),
			encode: SchemaGetter.transform((name: { token: string }) => name.token),
		},
	),
);

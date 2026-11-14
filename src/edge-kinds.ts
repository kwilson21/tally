// Typed kinds shared by the edge readers (decision 206): the words the app reads from an address or a form, once, for every route.
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { MAX_OCCURRENCE_CENTS } from "./bills/totals";
import { readAtEdge, readText } from "./edge";
import { PERSON_NAME_MAX } from "./limits";
import { formatCents, toCents } from "./money";

/**
 * A row id from the address or a form: a whole number above zero, written with digits only. Fifteen digits at most, so
 * the largest id is 999999999999999, under Number.MAX_SAFE_INTEGER (9007199254740991), and a larger one is refused. Ids
 * come from our own pages, so no leading zero, sign, space, decimal point or exponent is written by the app.
 */
export const RowId = Schema.String.check(
	Schema.isPattern(/^[1-9]\d{0,14}$/),
).pipe(Schema.decodeTo(Schema.NumberFromString));

/**
 * The place of a card on a page, from a form (Settings, a No's answer): digits only, leading zeros read as they always
 * were ("007" is 7). A place past the last card is drawn after it, so a huge one needs no cap. Other text is refused.
 */
export const CardPlace = Schema.String.check(Schema.isPattern(/^\d+$/)).pipe(
	Schema.decodeTo(Schema.NumberFromString),
);

/**
 * A purchase's or a category's number from an address or a form (Suggestions, #1006): digits only, at most fifteen, so
 * the value is a safe integer. Zeros in front are read as they always were ("007" is 7). Any other text is refused, as
 * the More card has always refused it.
 */
export const DigitsUpTo15 = Schema.String.check(
	Schema.isPattern(/^\d{1,15}$/),
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

const NOT_ABOVE_ZERO = "Enter an amount greater than $0.";

/**
 * A bill's amount typed on the bill sheet (bills, #1006), read into integer cents: a dollar amount above $0 and no more
 * than one occurrence can hold. Any other text is refused with one of the two sentences the sheet shows under the
 * field. The route keeps the text as typed for the echo.
 */
export const BillAmount = Schema.String.pipe(
	Schema.decodeTo(Schema.Number, {
		decode: readText<number>((text) => {
			let cents: number;

			try {
				cents = toCents(text);
			} catch {
				return { say: NOT_ABOVE_ZERO };
			}

			if (cents <= 0) return { say: NOT_ABOVE_ZERO };

			return cents <= MAX_OCCURRENCE_CENTS
				? { value: cents }
				: {
						say: `Enter an amount of ${formatCents(MAX_OCCURRENCE_CENTS, { wholeDollars: true })} or less.`,
					};
		}),
		encode: SchemaGetter.transform((cents: number) => (cents / 100).toFixed(2)),
	}),
);

/**
 * A number typed in a form, read the way Number() reads it: Schema's NumberFromString is Number() (effect 4.1.4,
 * SchemaGetter.Number is transform(globalThis.Number)), so "07" is 7, "5.0" is 5, "1e1" is 10, "" is 0, and text that
 * is no number is NaN. For the places whose answers must not change: the bill form's day, month and category, and the
 * Suggestions lists and queue id (#1006). The id in an address reads RowId instead.
 */
export function numberOf(text: string): number {
	const read = readAtEdge(Schema.NumberFromString, text);

	return read.ok ? read.value : Number.NaN;
}

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

/** True for a posted value that is text (a file part is not text). */
function isText(value: string | File | null | undefined): value is string {
	return typeof value === "string";
}

/** A posted field as text: "" when it is missing or a file part, so no id, token, name or address is read from a file. */
export const textOf = (posted: string | File | null | undefined): string =>
	isText(posted) ? posted : "";

/** A row id read at the edge (RowId), or undefined when the text is no row id. */
export function rowIdOf(text: string | undefined): number | undefined {
	const read = readAtEdge(RowId, text);

	return read.ok ? read.value : undefined;
}

/**
 * A row id read at the edge, or 0 when the text is no row id. No row has id 0, so a rule or a query given it finds
 * nothing, as it found nothing for a NaN.
 */
export function rowIdOrZero(text: string | undefined): number {
	return rowIdOf(text) ?? 0;
}

/** The row ids in a list of posted values, in the order posted: each one RowId reads, and every other entry is dropped. */
export const rowIdsOf = (posted: (string | File)[]): number[] =>
	posted.flatMap((value) => {
		const id = rowIdOf(textOf(value));

		return id === undefined ? [] : [id];
	});

/**
 * A bank sign-in address the form names to remove (Settings): trimmed and lower-cased, at most 254 characters, with one
 * @ and a dot after it, and no spaces. Any other text is refused with the sentence the page shows.
 */
export const SignInAddress = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: readText<string>((text) => {
			const email = text.trim().toLowerCase();

			return email &&
				email.length <= 254 &&
				/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
				? { value: email }
				: { say: "Choose an address to remove." };
		}),
		encode: SchemaGetter.passthrough(),
	}),
);

/**
 * A person's name from a form (Settings): trimmed, not empty, at most PERSON_NAME_MAX characters. The page keeps the
 * text as typed; only the name the rule saves is this trimmed one.
 */
export const PersonName = Schema.String.pipe(
	Schema.decodeTo(Schema.String, {
		decode: readText<string>((text) => {
			const name = text.trim();

			return name && name.length <= PERSON_NAME_MAX
				? { value: name }
				: { say: `Enter a name up to ${PERSON_NAME_MAX} characters.` };
		}),
		encode: SchemaGetter.passthrough(),
	}),
);

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export type PlaidEnv = {
	PLAID_CLIENT_ID?: string;
	PLAID_SECRET?: string;
	PLAID_ENV?: string;
	PLAID_WEBHOOK_URL?: string;
	TOKEN_ENCRYPTION_KEY?: string;
};

type PlaidErrorBody = {
	error_type?: unknown;
	error_code?: unknown;
	request_id?: unknown;
};

/** A JSON value, as a Plaid request body carries it. */
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [field: string]: JsonValue | undefined };

function isText(value: unknown): value is string {
	return typeof value === "string";
}

export class PlaidError extends Error {
	readonly error_type?: string;
	readonly error_code?: string;
	readonly request_id?: string;

	constructor(body: PlaidErrorBody = {}) {
		super("Plaid request failed");
		this.name = "PlaidError";
		this.error_type = isText(body.error_type) ? body.error_type : undefined;
		this.error_code = isText(body.error_code) ? body.error_code : undefined;
		this.request_id = isText(body.request_id) ? body.request_id : undefined;
	}
}

// The client in Effect (decision 210, step 1). A call fails in one of three named ways, and a good answer is read
// through its schema (decision 206), so a caller never holds a field Plaid did not send.

/** Plaid could not be reached: the request failed, or took longer than the timeout. */
export class PlaidUnreachable extends Data.TaggedError("PlaidUnreachable") {}

/** Plaid answered with something that is not JSON, or not the answer this call reads. */
export class PlaidUnreadable extends Data.TaggedError("PlaidUnreadable") {}

/** Plaid refused. It carries Plaid's own three fields and nothing else of the answer, so no token is copied. */
export class PlaidRefusal extends Data.TaggedError("PlaidRefusal")<{
	readonly error_type: string | undefined;
	readonly error_code: string | undefined;
	readonly request_id: string | undefined;
}> {}

export type PlaidFailure = PlaidUnreachable | PlaidUnreadable | PlaidRefusal;

/** How long one call may take, the request and the reading of its answer together. */
const TIMEOUT = "30 seconds";

type PlaidBody = { [field: string]: JsonValue | undefined };

/** What Plaid sent back: whether it accepted the request, and the text of its answer. */
type Sent = { ok: boolean; text: string };

// A refusal's three fields, each read on its own, so one that is missing or not text leaves the other two.
const ErrorType = Schema.Struct({ error_type: Schema.String });
const ErrorCode = Schema.Struct({ error_code: Schema.String });
const RequestId = Schema.Struct({ request_id: Schema.String });

const readField = <S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	body: JsonValue,
): S["Type"] | undefined =>
	Result.getOrUndefined(Schema.decodeUnknownResult(schema)(body));

/** What Plaid said when it refused; nothing else of the answer is kept. */
const refusalOf = (body: JsonValue) =>
	new PlaidRefusal({
		error_type: readField(ErrorType, body)?.error_type,
		error_code: readField(ErrorCode, body)?.error_code,
		request_id: readField(RequestId, body)?.request_id,
	});

/**
 * Asks Plaid one thing and reads the answer through `answer`. The timeout interrupts the request, which aborts it
 * through the signal the request is given.
 */
export const askPlaid = <S extends Schema.ConstraintDecoder<unknown>>(
	env: PlaidEnv,
	path: string,
	body: PlaidBody,
	answer: S,
	fetchImpl: typeof fetch = fetch,
): Effect.Effect<S["Type"], PlaidFailure> => {
	const baseUrl =
		env.PLAID_ENV === "production"
			? "https://production.plaid.com"
			: "https://sandbox.plaid.com";

	// The request and the reading of its answer share one signal, so a timeout stops the download too.
	const send = Effect.tryPromise({
		try: async (signal): Promise<Sent> => {
			const response = await fetchImpl(`${baseUrl}${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					...body,
					client_id: env.PLAID_CLIENT_ID,
					secret: env.PLAID_SECRET,
				}),
				signal,
			});

			return { ok: response.ok, text: await response.text() };
		},
		catch: () => new PlaidUnreachable(),
	});

	const read = (sent: Sent) =>
		Effect.try({
			try: (): JsonValue => JSON.parse(sent.text),
			catch: () => new PlaidUnreadable(),
		});

	return send.pipe(
		Effect.timeoutOrElse({
			duration: TIMEOUT,
			orElse: () => Effect.fail(new PlaidUnreachable()),
		}),
		Effect.flatMap((sent) =>
			Effect.flatMap(
				read(sent),
				(json): Effect.Effect<S["Type"], PlaidFailure> => {
					if (!sent.ok) return Effect.fail(refusalOf(json));
					const decoded = Schema.decodeUnknownResult(answer)(json);

					return Result.isSuccess(decoded)
						? Effect.succeed(decoded.success)
						: Effect.fail(new PlaidUnreadable());
				},
			),
		),
	);
};

/** A failure as the error the older callers catch: Plaid's three fields for a refusal, and none otherwise. */
const thrown = (failure: PlaidFailure) =>
	new PlaidError(Predicate.isTagged(failure, "PlaidRefusal") ? failure : {});

/**
 * Runs a call for a caller that is not in Effect yet, and throws `PlaidError` when it fails, as the client always
 * did. The sync's page loop and the webhook's key check use it until their own steps (decision 210).
 */
export async function orThrow<A>(
	asked: Effect.Effect<A, PlaidFailure>,
): Promise<A> {
	const result = await Effect.runPromise(Effect.result(asked));

	if (Result.isSuccess(result)) return result.success;

	throw thrown(result.failure);
}

/** One call whose answer the caller names and nothing checks: for the callers that are not in Effect yet. */
export async function plaidPost<T>(
	env: PlaidEnv,
	path: string,
	body: PlaidBody,
	fetchImpl: typeof fetch = fetch,
): Promise<T> {
	const parsed = await orThrow(
		askPlaid(env, path, body, Schema.Unknown, fetchImpl),
	);

	// SAFETY: T is the response shape the caller names for this Plaid path, and parsed is that path's JSON body.
	return parsed as T;
}

export type LinkTokenRequest = {
	user: { client_user_id: string };
	client_name: string;
	/** New-item Link uses products; update mode identifies the existing item instead. */
	products?: ["transactions"];
	access_token?: string;
	country_codes: ["US"];
	language: "en";
	webhook?: string;
};

export const createLinkToken = (
	env: PlaidEnv,
	body: LinkTokenRequest,
	fetchImpl?: typeof fetch,
) =>
	askPlaid(
		env,
		"/link/token/create",
		body,
		Schema.Struct({ link_token: Schema.String }),
		fetchImpl,
	);

export const exchangePublicToken = (
	env: PlaidEnv,
	publicToken: string,
	fetchImpl?: typeof fetch,
) =>
	askPlaid(
		env,
		"/item/public_token/exchange",
		{ public_token: publicToken },
		Schema.Struct({ access_token: Schema.String, item_id: Schema.String }),
		fetchImpl,
	);

/** An item as Plaid describes it. Its `error` is null while the login works, and Plaid's own object while it does not. */
const Item = Schema.Struct({
	item: Schema.Struct({
		institution_id: Schema.optional(Schema.NullOr(Schema.String)),
		error: Schema.optional(Schema.Unknown),
	}),
});

export const getItem = (
	env: PlaidEnv,
	accessToken: string,
	fetchImpl?: typeof fetch,
) => askPlaid(env, "/item/get", { access_token: accessToken }, Item, fetchImpl);

export const removeItem = (
	env: PlaidEnv,
	accessToken: string,
	fetchImpl?: typeof fetch,
) =>
	askPlaid(
		env,
		"/item/remove",
		{ access_token: accessToken },
		Schema.Struct({ request_id: Schema.optional(Schema.String) }),
		fetchImpl,
	);

const Institution = Schema.Struct({
	institution: Schema.optional(
		Schema.Struct({ name: Schema.optional(Schema.String) }),
	),
});

/** The institution's name, or undefined when Plaid gives none. */
export const getInstitutionName = (
	env: PlaidEnv,
	institutionId: string,
	fetchImpl?: typeof fetch,
) =>
	askPlaid(
		env,
		"/institutions/get_by_id",
		{ institution_id: institutionId, country_codes: ["US"] },
		Institution,
		fetchImpl,
	).pipe(Effect.map((answer) => answer.institution?.name));

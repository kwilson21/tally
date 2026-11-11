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

function isErrorBody(value: unknown): value is PlaidErrorBody {
	return typeof value === "object" && value !== null;
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

export async function plaidPost<T>(
	env: PlaidEnv,
	path: string,
	body: { [field: string]: JsonValue | undefined },
	fetchImpl: typeof fetch = fetch,
): Promise<T> {
	const baseUrl =
		env.PLAID_ENV === "production"
			? "https://production.plaid.com"
			: "https://sandbox.plaid.com";

	let response: Response;

	try {
		response = await fetchImpl(`${baseUrl}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				...body,
				client_id: env.PLAID_CLIENT_ID,
				secret: env.PLAID_SECRET,
			}),
			signal: AbortSignal.timeout(30_000),
		});
	} catch {
		throw new PlaidError();
	}

	let parsed: unknown;

	try {
		parsed = JSON.parse(await response.text());
	} catch {
		throw new PlaidError();
	}

	if (!response.ok) {
		throw new PlaidError(isErrorBody(parsed) ? parsed : {});
	}

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
	plaidPost<{ link_token: string }>(env, "/link/token/create", body, fetchImpl);

export const exchangePublicToken = (
	env: PlaidEnv,
	publicToken: string,
	fetchImpl?: typeof fetch,
) =>
	plaidPost<{ access_token: string; item_id: string }>(
		env,
		"/item/public_token/exchange",
		{ public_token: publicToken },
		fetchImpl,
	);

export const getItem = (
	env: PlaidEnv,
	accessToken: string,
	fetchImpl?: typeof fetch,
) =>
	plaidPost<{
		item: {
			institution_id?: string | null;
			error?: object | null;
		};
	}>(env, "/item/get", { access_token: accessToken }, fetchImpl);

export const removeItem = (
	env: PlaidEnv,
	accessToken: string,
	fetchImpl?: typeof fetch,
) =>
	plaidPost<{ request_id?: string }>(
		env,
		"/item/remove",
		{ access_token: accessToken },
		fetchImpl,
	);

export async function getInstitutionName(
	env: PlaidEnv,
	institutionId: string,
	fetchImpl?: typeof fetch,
): Promise<string | undefined> {
	const result = await plaidPost<{ institution?: { name?: string } }>(
		env,
		"/institutions/get_by_id",
		{ institution_id: institutionId, country_codes: ["US"] },
		fetchImpl,
	);

	return result.institution?.name;
}

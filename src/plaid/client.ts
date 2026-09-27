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

export class PlaidError extends Error {
	readonly error_type?: string;
	readonly error_code?: string;
	readonly request_id?: string;

	constructor(body: PlaidErrorBody = {}) {
		super("Plaid request failed");
		this.name = "PlaidError";
		this.error_type =
			typeof body.error_type === "string" ? body.error_type : undefined;
		this.error_code =
			typeof body.error_code === "string" ? body.error_code : undefined;
		this.request_id =
			typeof body.request_id === "string" ? body.request_id : undefined;
	}
}

export async function plaidPost<T>(
	env: PlaidEnv,
	path: string,
	body: Record<string, unknown>,
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
		throw new PlaidError(
			typeof parsed === "object" && parsed !== null
				? (parsed as PlaidErrorBody)
				: {},
		);
	}
	return parsed as T;
}

export type LinkTokenRequest = {
	user: { client_user_id: string };
	client_name: string;
	products: ["transactions"];
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
	plaidPost<{ item: { institution_id?: string | null } }>(
		env,
		"/item/get",
		{ access_token: accessToken },
		fetchImpl,
	);

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

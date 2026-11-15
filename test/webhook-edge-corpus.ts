// Inputs for the three outside reads on the Plaid webhook's path (#1149): the verification token's header and claims
// (src/plaid/webhook-verify.ts), the answer to Plaid's key fetch (the same file, through plaidPost) and the webhook's own
// body (src/routes/webhooks.ts). Each case gives one read an odd input, one thing at a time. Pure data: the characterise
// test signs and sends each case through the real route or verifier and compares the answer with
// fixtures/webhook-edge-baseline.json, recorded on the code before any of the three moved to Effect Schema. Every id here
// is made up.

/** One odd verification token: texts for the signed parts, and a flaw in the signature or the shape. */
export type TokenCase = {
	label: string;
	site: "token";
	/** The header's JSON text; absent is a good ES256 header. `{kid}` is replaced with this case's own key id. */
	header?: string;
	/** The claims' JSON text; absent is a good one. `{iat}` and `{sha}` are replaced with a good time and digest. */
	claims?: string;
	signature?: "good" | "flipped" | "short" | "long" | "empty" | "other-key";
	/** A whole header value to send as it is, with no signing. */
	whole?: string | null;
};

/** One odd answer from Plaid's key fetch. */
export type KeyCase = {
	label: string;
	site: "key";
	/** The answer's body, with `{jwk}` replaced by the signing key's public JWK. */
	body: string;
	status?: number;
	throws?: boolean;
};

/** One odd webhook body, signed correctly, for a known bank (or not). */
export type BodyCase = {
	label: string;
	site: "body";
	body: string;
	/** `none` and `bad` send a bad Plaid-Verification header; `key-down` makes Plaid's key fetch answer 500. */
	token?: "good" | "none" | "bad" | "key-down";
	/** The bank's row: absent is a bank named item-1 that is connected. */
	item?: "none" | "disconnected";
};

export type EdgeCase = TokenCase | KeyCase | BodyCase;

const nest = (depth: number, open: string, close: string) =>
	open.repeat(depth) + close.repeat(depth);

const deepArray = (depth: number) => nest(depth, "[", "]");

const deepObject = (depth: number) =>
	`${'{"a":'.repeat(depth)}null${"}".repeat(depth)}`;

const KID = '"kid":"{kid}"';

const header = (rest: string) => `{"alg":"ES256",${rest}}`;

const claims = (iat: string, sha = '"{sha}"') =>
	`{"iat":${iat},"request_body_sha256":${sha}}`;

/** Odd texts for the two signed parts: JSON that is not an object, and text that is not JSON. */
const ODD_PARTS: [string, string][] = [
	["JSON null", "null"],
	["JSON array", "[]"],
	["JSON string", '"ES256"'],
	["JSON number", "123"],
	["JSON true", "true"],
	["empty object", "{}"],
	["not JSON", "not json"],
	["truncated", '{"alg":"ES256"'],
	["empty text", ""],
	["BOM before JSON", '﻿{"alg":"ES256"}'],
	["depth 5000 array", deepArray(5000)],
	["depth 5000 object", deepObject(5000)],
];

export const tokenCases = (): TokenCase[] => [
	{ label: "token | good", site: "token" },
	...ODD_PARTS.map(
		([name, text]): TokenCase => ({
			label: `token | header | ${name}`,
			site: "token",
			header: text,
		}),
	),
	...ODD_PARTS.map(
		([name, text]): TokenCase => ({
			label: `token | claims | ${name}`,
			site: "token",
			claims: text,
		}),
	),
	{
		label: "token | header | alg none",
		site: "token",
		header: `{"alg":"none",${KID}}`,
	},
	{
		label: "token | header | alg HS256",
		site: "token",
		header: `{"alg":"HS256",${KID}}`,
	},
	{
		label: "token | header | alg lower case",
		site: "token",
		header: `{"alg":"es256",${KID}}`,
	},
	{
		label: "token | header | alg number",
		site: "token",
		header: `{"alg":256,${KID}}`,
	},
	{
		label: "token | header | alg array",
		site: "token",
		header: `{"alg":["ES256"],${KID}}`,
	},
	{ label: "token | header | no alg", site: "token", header: `{${KID}}` },
	{ label: "token | header | no kid", site: "token", header: header('"x":1') },
	{
		label: "token | header | kid empty",
		site: "token",
		header: header('"kid":""'),
	},
	{
		label: "token | header | kid number",
		site: "token",
		header: header('"kid":1'),
	},
	{
		label: "token | header | kid null",
		site: "token",
		header: header('"kid":null'),
	},
	{
		label: "token | header | kid array",
		site: "token",
		header: header('"kid":["a"]'),
	},
	{
		label: "token | header | kid 129 characters",
		site: "token",
		header: header(`"kid":"${"k".repeat(129)}"`),
	},
	{
		label: "token | header | kid lone surrogate",
		site: "token",
		header: header('"kid":"\\ud800"'),
	},
	{
		label: "token | header | kid 1e999",
		site: "token",
		header: header('"kid":1e999'),
	},
	{
		label: "token | header | crit empty array",
		site: "token",
		header: header(`${KID},"crit":[]`),
	},
	{
		label: "token | header | crit null",
		site: "token",
		header: header(`${KID},"crit":null`),
	},
	{
		label: "token | header | crit text",
		site: "token",
		header: header(`${KID},"crit":"exp"`),
	},
	{
		label: "token | header | extra fields",
		site: "token",
		header: header(`${KID},"typ":"JWT","x":{"y":[1,2,3]}`),
	},
	{
		label: "token | header | duplicate alg",
		site: "token",
		header: `{"alg":"none","alg":"ES256",${KID}}`,
	},
	{
		label: "token | header | duplicate kid",
		site: "token",
		header: `{"alg":"ES256","kid":"other",${KID}}`,
	},
	{
		label: "token | header | __proto__ key",
		site: "token",
		header: header(`${KID},"__proto__":{"alg":"none"}`),
	},
	{
		label: "token | header | depth 1000 inside an extra field",
		site: "token",
		header: header(`${KID},"x":${deepArray(1000)}`),
	},
	{
		label: "token | header | depth 5000 inside an extra field",
		site: "token",
		header: header(`${KID},"x":${deepArray(5000)}`),
	},
	{
		label: "token | claims | no iat",
		site: "token",
		claims: '{"request_body_sha256":"{sha}"}',
	},
	{
		label: "token | claims | iat text",
		site: "token",
		claims: claims('"{iat}"'),
	},
	{ label: "token | claims | iat null", site: "token", claims: claims("null") },
	{
		label: "token | claims | iat true",
		site: "token",
		claims: claims("true"),
	},
	{
		label: "token | claims | iat array",
		site: "token",
		claims: claims("[{iat}]"),
	},
	{
		label: "token | claims | iat 1e999",
		site: "token",
		claims: claims("1e999"),
	},
	{
		label: "token | claims | iat minus 1e999",
		site: "token",
		claims: claims("-1e999"),
	},
	{
		label: "token | claims | iat 1e400",
		site: "token",
		claims: claims("1e400"),
	},
	{
		label: "token | claims | iat 2^53+1",
		site: "token",
		claims: claims("9007199254740993"),
	},
	{
		label: "token | claims | iat zero",
		site: "token",
		claims: claims("0"),
	},
	{
		label: "token | claims | iat minus zero",
		site: "token",
		claims: claims("-0"),
	},
	{
		label: "token | claims | iat 400 seconds old",
		site: "token",
		claims: claims("{iat-400}"),
	},
	{
		label: "token | claims | iat 200 seconds old",
		site: "token",
		claims: claims("{iat-200}"),
	},
	{
		label: "token | claims | iat 30 seconds ahead",
		site: "token",
		claims: claims("{iat+30}"),
	},
	{
		label: "token | claims | iat 120 seconds ahead",
		site: "token",
		claims: claims("{iat+120}"),
	},
	{
		label: "token | claims | iat with a fraction",
		site: "token",
		claims: claims("{iat}.5"),
	},
	{
		label: "token | claims | iat as an exponent",
		site: "token",
		claims: claims("{iat}e0"),
	},
	{
		label: "token | claims | duplicate iat, the old one first",
		site: "token",
		claims: `{"iat":0,"iat":{iat},"request_body_sha256":"{sha}"}`,
	},
	{
		label: "token | claims | duplicate iat, the old one last",
		site: "token",
		claims: `{"iat":{iat},"iat":0,"request_body_sha256":"{sha}"}`,
	},
	{
		label: "token | claims | no digest",
		site: "token",
		claims: '{"iat":{iat}}',
	},
	{
		label: "token | claims | digest number",
		site: "token",
		claims: claims("{iat}", "5"),
	},
	{
		label: "token | claims | digest null",
		site: "token",
		claims: claims("{iat}", "null"),
	},
	{
		label: "token | claims | digest array",
		site: "token",
		claims: claims("{iat}", '["{sha}"]'),
	},
	{
		label: "token | claims | digest upper case",
		site: "token",
		claims: claims("{iat}", '"{SHA}"'),
	},
	{
		label: "token | claims | digest 63 characters",
		site: "token",
		claims: claims("{iat}", '"{sha63}"'),
	},
	{
		label: "token | claims | digest of another body",
		site: "token",
		claims: claims("{iat}", `"${"0".repeat(64)}"`),
	},
	{
		label: "token | claims | extra fields",
		site: "token",
		claims: `{"iat":{iat},"request_body_sha256":"{sha}","x":{"y":[1,2,3]}}`,
	},
	{
		label: "token | claims | __proto__ key",
		site: "token",
		claims: `{"iat":{iat},"request_body_sha256":"{sha}","__proto__":{"iat":0}}`,
	},
	{
		label: "token | claims | depth 1000 inside an extra field",
		site: "token",
		claims: `{"iat":{iat},"request_body_sha256":"{sha}","x":${deepArray(1000)}}`,
	},
	{
		label: "token | claims | depth 5000 inside an extra field",
		site: "token",
		claims: `{"iat":{iat},"request_body_sha256":"{sha}","x":${deepArray(5000)}}`,
	},
	{
		label: "token | signature | flipped",
		site: "token",
		signature: "flipped",
	},
	{
		label: "token | signature | 63 bytes",
		site: "token",
		signature: "short",
	},
	{
		label: "token | signature | 65 bytes",
		site: "token",
		signature: "long",
	},
	{
		label: "token | signature | empty",
		site: "token",
		signature: "empty",
	},
	{
		label: "token | signature | another key's",
		site: "token",
		signature: "other-key",
	},
	{ label: "token | whole | absent", site: "token", whole: null },
	{ label: "token | whole | empty", site: "token", whole: "" },
	{ label: "token | whole | bad", site: "token", whole: "bad" },
	{ label: "token | whole | two parts", site: "token", whole: "a.b" },
	{ label: "token | whole | four parts", site: "token", whole: "a.b.c.d" },
	{ label: "token | whole | three empty parts", site: "token", whole: ".." },
	{
		label: "token | whole | padding",
		site: "token",
		whole: "eyJhbGciOiJFUzI1NiJ9=.e30=.AAAA",
	},
	{
		label: "token | whole | characters outside base64url",
		site: "token",
		whole: "ey+hbGci/iJFUzI1NiJ9.e30.AAAA",
	},
	{
		label: "token | whole | spaces",
		site: "token",
		whole: " eyJhbGciOiJFUzI1NiJ9.e30.AAAA ",
	},
	{
		label: "token | whole | 100k characters",
		site: "token",
		whole: `${"a".repeat(100_000)}.b.c`,
	},
	{
		label: "token | whole | Bearer prefix",
		site: "token",
		whole: "Bearer a.b.c",
	},
];

/** Odd answers from Plaid's key fetch: the key's own shape, its expiry, and bodies that are not a key at all. */
export const keyCases = (): KeyCase[] => [
	{ label: "key | good", site: "key", body: '{"key":{jwk}}' },
	{
		label: "key | expired_at null",
		site: "key",
		body: '{"key":{jwk,"expired_at":null}}',
	},
	{
		label: "key | expired_at a number",
		site: "key",
		body: '{"key":{jwk,"expired_at":1700000000}}',
	},
	{
		label: "key | expired_at zero",
		site: "key",
		body: '{"key":{jwk,"expired_at":0}}',
	},
	{
		label: "key | expired_at text",
		site: "key",
		body: '{"key":{jwk,"expired_at":"never"}}',
	},
	{
		label: "key | expired_at false",
		site: "key",
		body: '{"key":{jwk,"expired_at":false}}',
	},
	{
		label: "key | expired_at 1e999",
		site: "key",
		body: '{"key":{jwk,"expired_at":1e999}}',
	},
	{ label: "key | empty object", site: "key", body: "{}" },
	{ label: "key | key null", site: "key", body: '{"key":null}' },
	{ label: "key | key text", site: "key", body: '{"key":"abc"}' },
	{ label: "key | key empty text", site: "key", body: '{"key":""}' },
	{ label: "key | key number", site: "key", body: '{"key":5}' },
	{ label: "key | key zero", site: "key", body: '{"key":0}' },
	{ label: "key | key true", site: "key", body: '{"key":true}' },
	{ label: "key | key false", site: "key", body: '{"key":false}' },
	{ label: "key | key array", site: "key", body: '{"key":[]}' },
	{ label: "key | key empty object", site: "key", body: '{"key":{}}' },
	{
		label: "key | key object with no usable fields",
		site: "key",
		body: '{"key":{"expired_at":null}}',
	},
	{
		label: "key | key of the wrong curve",
		site: "key",
		body: '{"key":{"kty":"EC","crv":"P-384","x":"AAAA","y":"AAAA","expired_at":null}}',
	},
	{
		label: "key | key of another type",
		site: "key",
		body: '{"key":{"kty":"oct","k":"AAAA","expired_at":null}}',
	},
	{
		label: "key | key coordinates numbers",
		site: "key",
		body: '{"key":{"kty":"EC","crv":"P-256","x":1,"y":2,"expired_at":null}}',
	},
	{ label: "key | answer null", site: "key", body: "null" },
	{ label: "key | answer array", site: "key", body: "[]" },
	{ label: "key | answer text", site: "key", body: '"key"' },
	{ label: "key | answer number", site: "key", body: "7" },
	{ label: "key | answer true", site: "key", body: "true" },
	{ label: "key | not JSON", site: "key", body: "not json" },
	{ label: "key | empty body", site: "key", body: "" },
	{ label: "key | truncated", site: "key", body: '{"key":{' },
	{
		label: "key | extra fields beside a good key",
		site: "key",
		body: '{"key":{jwk,"expired_at":null},"request_id":"r","x":[1,{"y":2}]}',
	},
	{
		label: "key | duplicate key, the bad one last",
		site: "key",
		body: '{"key":{jwk,"expired_at":null},"key":null}',
	},
	{
		label: "key | duplicate key, the bad one first",
		site: "key",
		body: '{"key":null,"key":{jwk,"expired_at":null}}',
	},
	{
		label: "key | __proto__ key",
		site: "key",
		body: '{"__proto__":{"key":{jwk,"expired_at":null}}}',
	},
	{
		label: "key | depth 5000 beside a good key",
		site: "key",
		body: `{"key":{jwk,"expired_at":null},"x":${deepArray(5000)}}`,
	},
	{
		label: "key | depth 5000 as the answer",
		site: "key",
		body: deepArray(5000),
	},
	{
		label: "key | a 2MB text beside a good key",
		site: "key",
		body: `{"key":{jwk,"expired_at":null},"x":"${"a".repeat(2_000_000)}"}`,
	},
	{
		label: "key | status 400 with a Plaid refusal",
		site: "key",
		status: 400,
		body: '{"error_type":"INVALID_INPUT","error_code":"INVALID_FIELD","error_message":"m","request_id":"r"}',
	},
	{
		label: "key | status 400 with a good key",
		site: "key",
		status: 400,
		body: '{"key":{jwk,"expired_at":null}}',
	},
	{ label: "key | status 500 empty", site: "key", status: 500, body: "" },
	{
		label: "key | status 200 with a Plaid refusal",
		site: "key",
		body: '{"error_type":"API_ERROR","error_code":"INTERNAL_SERVER_ERROR","error_message":"m","request_id":"r"}',
	},
	{ label: "key | the fetch throws", site: "key", body: "", throws: true },
];

/** Odd bodies: JSON that is not an object, an object whose fields are the wrong type, and ones Plaid never sends. */
const BODY = (fields: string) => `{"item_id":"item-1",${fields}}`;

export const bodyCases = (): BodyCase[] => [
	{ label: "body | not JSON", site: "body", body: "not json" },
	{ label: "body | empty", site: "body", body: "" },
	{ label: "body | truncated", site: "body", body: '{"item_id":"item-1"' },
	{
		label: "body | BOM before JSON",
		site: "body",
		body: '﻿{"item_id":"item-1"}',
	},
	{ label: "body | JSON null", site: "body", body: "null" },
	{ label: "body | JSON array", site: "body", body: "[]" },
	{
		label: "body | array of the object",
		site: "body",
		body: '[{"item_id":"item-1","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}]',
	},
	{ label: "body | JSON number", site: "body", body: "123" },
	{ label: "body | JSON text", site: "body", body: '"item-1"' },
	{ label: "body | JSON true", site: "body", body: "true" },
	{ label: "body | empty object", site: "body", body: "{}" },
	{ label: "body | depth 5000 array", site: "body", body: deepArray(5000) },
	{ label: "body | depth 5000 object", site: "body", body: deepObject(5000) },
	{
		label: "body | item_id missing",
		site: "body",
		body: '{"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id number",
		site: "body",
		body: '{"item_id":1,"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id null",
		site: "body",
		body: '{"item_id":null,"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id array",
		site: "body",
		body: '{"item_id":["item-1"],"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id object",
		site: "body",
		body: '{"item_id":{"id":"item-1"},"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id empty",
		site: "body",
		body: '{"item_id":"","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id another bank",
		site: "body",
		body: '{"item_id":"item-2","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id with SQL in it",
		site: "body",
		body: '{"item_id":"item-1\' OR \'1\'=\'1","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id escaped",
		site: "body",
		body: '{"item_id":"item\\u002d1","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id lone surrogate",
		site: "body",
		body: '{"item_id":"\\ud800","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | item_id 2MB",
		site: "body",
		body: `{"item_id":"${"a".repeat(2_000_000)}","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}`,
	},
	{
		label: "body | duplicate item_id, the known one last",
		site: "body",
		body: '{"item_id":"item-2","item_id":"item-1","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | duplicate item_id, the known one first",
		site: "body",
		body: '{"item_id":"item-1","item_id":"item-2","webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"}',
	},
	{
		label: "body | __proto__ key",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION","__proto__":{"item_id":"item-2"}',
		),
	},
	{
		label: "body | PENDING_EXPIRATION",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"'),
	},
	{
		label: "body | PENDING_DISCONNECT",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"PENDING_DISCONNECT"'),
	},
	{
		label: "body | USER_PERMISSION_REVOKED",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"USER_PERMISSION_REVOKED"',
		),
	},
	{
		label: "body | relink code in a type that is not ITEM",
		site: "body",
		body: BODY(
			'"webhook_type":"TRANSACTIONS","webhook_code":"PENDING_EXPIRATION"',
		),
	},
	{
		label: "body | relink code in lower case",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"pending_expiration"'),
	},
	{
		label: "body | relink code with a space",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION "'),
	},
	{
		label: "body | webhook_code a number",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":1'),
	},
	{
		label: "body | webhook_code an array",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":["PENDING_EXPIRATION"]'),
	},
	{
		label: "body | webhook_code null",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":null'),
	},
	{
		label: "body | webhook_code missing",
		site: "body",
		body: BODY('"webhook_type":"ITEM"'),
	},
	{
		label: "body | webhook_type missing",
		site: "body",
		body: BODY('"webhook_code":"PENDING_EXPIRATION"'),
	},
	{
		label: "body | webhook_type an array",
		site: "body",
		body: BODY('"webhook_type":["ITEM"],"webhook_code":"PENDING_EXPIRATION"'),
	},
	{
		label: "body | ERROR with a login error",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":"ITEM_LOGIN_REQUIRED"}',
		),
	},
	{
		label: "body | ERROR with a transient error",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":"PRODUCT_NOT_READY"}',
		),
	},
	{
		label: "body | ERROR with no error",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"ERROR"'),
	},
	{
		label: "body | ERROR with error null",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"ERROR","error":null'),
	},
	{
		label: "body | ERROR with error text",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"ERROR","error":"x"'),
	},
	{
		label: "body | ERROR with error a number",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"ERROR","error":5'),
	},
	{
		label: "body | ERROR with error an array",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"ERROR","error":[]'),
	},
	{
		label: "body | ERROR with error empty",
		site: "body",
		body: BODY('"webhook_type":"ITEM","webhook_code":"ERROR","error":{}'),
	},
	{
		label: "body | ERROR with error_code a number",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":1}',
		),
	},
	{
		label: "body | ERROR with error_code an array",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":["PRODUCT_NOT_READY"]}',
		),
	},
	{
		label: "body | ERROR with error_code null",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":null}',
		),
	},
	{
		label: "body | ERROR with a transient code in lower case",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":"product_not_ready"}',
		),
	},
	{
		label: "body | ERROR with a deep error",
		site: "body",
		body: BODY(
			`"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":"ITEM_LOGIN_REQUIRED","x":${deepArray(1000)}}`,
		),
	},
	{
		label: "body | ERROR on a disconnected bank",
		site: "body",
		item: "disconnected",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":"ITEM_LOGIN_REQUIRED"}',
		),
	},
	{
		label: "body | ERROR on no bank",
		site: "body",
		item: "none",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"ERROR","error":{"error_code":"ITEM_LOGIN_REQUIRED"}',
		),
	},
	{
		label: "body | sync",
		site: "body",
		body: BODY(
			'"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE"',
		),
	},
	{
		label: "body | sync with the history complete",
		site: "body",
		body: BODY(
			'"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","historical_update_complete":true',
		),
	},
	{
		label: "body | sync with the history complete as text",
		site: "body",
		body: BODY(
			'"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","historical_update_complete":"true"',
		),
	},
	{
		label: "body | sync with the history complete as 1",
		site: "body",
		body: BODY(
			'"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","historical_update_complete":1',
		),
	},
	{
		label: "body | sync with the history complete false",
		site: "body",
		body: BODY(
			'"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE","historical_update_complete":false',
		),
	},
	{
		label: "body | sync on a disconnected bank",
		site: "body",
		item: "disconnected",
		body: BODY(
			'"webhook_type":"TRANSACTIONS","webhook_code":"SYNC_UPDATES_AVAILABLE"',
		),
	},
	{
		label: "body | sync with the type as text of another case",
		site: "body",
		body: BODY(
			'"webhook_type":"transactions","webhook_code":"SYNC_UPDATES_AVAILABLE"',
		),
	},
	{
		label: "body | other transactions webhook",
		site: "body",
		body: BODY('"webhook_type":"TRANSACTIONS","webhook_code":"DEFAULT_UPDATE"'),
	},
	{
		label: "body | an extra number 1e999",
		site: "body",
		body: BODY(
			'"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION","x":1e999',
		),
	},
	{
		label: "body | an extra depth 5000 array",
		site: "body",
		body: BODY(
			`"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION","x":${deepArray(5000)}`,
		),
	},
	{
		label: "body | an extra 2MB text",
		site: "body",
		body: BODY(
			`"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION","x":"${"a".repeat(2_000_000)}"`,
		),
	},
	{
		label: "body | no header",
		site: "body",
		token: "none",
		body: BODY('"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"'),
	},
	{
		label: "body | bad header",
		site: "body",
		token: "bad",
		body: BODY('"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"'),
	},
	{
		label: "body | key fetch down",
		site: "body",
		token: "key-down",
		body: BODY('"webhook_type":"ITEM","webhook_code":"PENDING_EXPIRATION"'),
	},
	{
		label: "body | no header and a body that is not JSON",
		site: "body",
		token: "none",
		body: "not json",
	},
	{
		label: "body | key fetch down and a body that is not JSON",
		site: "body",
		token: "key-down",
		body: "not json",
	},
];

export const cases = (): EdgeCase[] => [
	...tokenCases(),
	...keyCases(),
	...bodyCases(),
];

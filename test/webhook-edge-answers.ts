// What each webhook edge case answers, as one string: the real verifier or the real route run on the case, with Plaid
// stood in for by a fetch that answers as the case says. Shared by the characterise test and the baseline recorder (#1149).
// A reader that throws answers its error's class and nothing else, since a message can hold what was sent.

import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { app } from "../src/index";
import { encryptToken } from "../src/plaid/token-crypto";
import { verifyPlaidWebhook } from "../src/plaid/webhook-verify";
import type {
	BodyCase,
	EdgeCase,
	KeyCase,
	TokenCase,
} from "./webhook-edge-corpus";

const KEY = btoa("01234567890123456789012345678901");
const encoder = new TextEncoder();

const b64 = (bytes: Uint8Array) =>
	btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");

const b64Text = (text: string) => b64(encoder.encode(text));

const hex = (bytes: Uint8Array) =>
	Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

async function keyPair() {
	const pair = await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	);

	if (!("privateKey" in pair))
		throw new Error("ECDSA generateKey returns a key pair");

	return pair;
}

const sha256 = async (text: string) =>
	new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

/** A fixed webhook body for the cases that are about the token, not the body. */
const TOKEN_BODY = '{"item_id":"item-1","webhook_type":"ITEM"}';

/** The text of a case with its placeholders filled: the key id, the time, the digest and the public key. */
function filled(
	text: string,
	values: { kid: string; iat: number; sha: string; jwk: string },
) {
	return text
		.replace(/\{iat([+-]\d+)\}/g, (_all, offset: string) =>
			String(values.iat + Number(offset)),
		)
		.replaceAll("{iat}", String(values.iat))
		.replaceAll("{kid}", values.kid)
		.replaceAll("{SHA}", values.sha.toUpperCase())
		.replaceAll("{sha63}", values.sha.slice(0, 63))
		.replaceAll("{sha}", values.sha)
		.replaceAll("{jwk}", values.jwk)
		.replaceAll("{jwk,", `{${values.jwk.slice(1, -1)},`);
}

const plaidEnv = {
	PLAID_CLIENT_ID: "client",
	PLAID_SECRET: "secret",
	PLAID_ENV: "sandbox",
};

const errorClass = (error: unknown) =>
	error instanceof Error ? error.constructor.name : typeof error;

/** The answer of one token case: the verifier's word, and how many times it asked Plaid for a key. */
async function tokenAnswer(item: TokenCase): Promise<string> {
	const pair = await keyPair();
	const other = await keyPair();
	const kid = crypto.randomUUID();
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const sha = hex(await sha256(TOKEN_BODY));

	const values = {
		kid,
		iat: Math.floor(Date.now() / 1000),
		sha,
		jwk: JSON.stringify({ ...jwk, expired_at: null }),
	};

	const headerText = filled(
		item.header ?? '{"alg":"ES256","kid":"{kid}"}',
		values,
	);

	const claimsText = filled(
		item.claims ?? '{"iat":{iat},"request_body_sha256":"{sha}"}',
		values,
	);

	const signed = `${b64Text(headerText)}.${b64Text(claimsText)}`;
	const signer = item.signature === "other-key" ? other : pair;

	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			signer.privateKey,
			encoder.encode(signed),
		),
	);

	const sent = {
		good: signature,
		"other-key": signature,
		flipped: Uint8Array.from(signature, (byte, index) =>
			index === 10 ? byte ^ 1 : byte,
		),
		short: signature.slice(0, 63),
		long: Uint8Array.from([...signature, 0]),
		empty: new Uint8Array(),
	}[item.signature ?? "good"];

	const value =
		item.whole !== undefined ? item.whole : `${signed}.${b64(sent)}`;
	let calls = 0;

	const fetchImpl = vi.fn(async () => {
		calls += 1;

		return Response.json({ key: { ...jwk, expired_at: null } });
	});

	try {
		const verdict = await verifyPlaidWebhook(
			plaidEnv,
			TOKEN_BODY,
			value,
			fetchImpl,
		);

		return `${verdict} | key fetches ${calls}`;
	} catch (error) {
		return `throws ${errorClass(error)} | key fetches ${calls}`;
	}
}

/** The answer of one key case: the verifier's word on a good token whose key answer is the case's. */
async function keyAnswer(item: KeyCase): Promise<string> {
	const pair = await keyPair();
	const kid = crypto.randomUUID();
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const sha = hex(await sha256(TOKEN_BODY));

	const values = {
		kid,
		iat: Math.floor(Date.now() / 1000),
		sha,
		jwk: JSON.stringify(jwk),
	};

	const signed = `${b64Text(filled('{"alg":"ES256","kid":"{kid}"}', values))}.${b64Text(
		filled('{"iat":{iat},"request_body_sha256":"{sha}"}', values),
	)}`;

	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			encoder.encode(signed),
		),
	);

	let calls = 0;

	const fetchImpl = vi.fn(async () => {
		calls += 1;

		if (item.throws) throw new TypeError("network down");

		return new Response(filled(item.body, values), {
			status: item.status ?? 200,
		});
	});

	try {
		const verdict = await verifyPlaidWebhook(
			plaidEnv,
			TOKEN_BODY,
			`${signed}.${b64(signature)}`,
			fetchImpl,
		);

		return `${verdict} | key fetches ${calls}`;
	} catch (error) {
		return `throws ${errorClass(error)} | key fetches ${calls}`;
	}
}

/** The answer of one body case: the route's status, the bank's row afterwards and every call the run made to Plaid. */
async function bodyAnswer(item: BodyCase): Promise<string> {
	await env.DB.batch([
		env.DB.prepare("DELETE FROM transactions"),
		env.DB.prepare("DELETE FROM accounts"),
		env.DB.prepare("DELETE FROM plaid_items"),
		env.DB.prepare("DELETE FROM merchant_suggested_names"),
		env.DB.prepare("DELETE FROM merchants"),
	]);

	Object.assign(env, {
		DEMO: "false",
		PLAID_CLIENT_ID: "client",
		PLAID_SECRET: "secret",
		PLAID_ENV: "sandbox",
		TOKEN_ENCRYPTION_KEY: KEY,
	});

	if (item.item !== "none")
		await env.DB.prepare(
			`INSERT INTO plaid_items (plaid_item_id, access_token_encrypted, institution_name, linked_by, disconnected_at) VALUES ('item-1', ?, 'Bank', 'person', ${item.item === "disconnected" ? "datetime('now')" : "NULL"})`,
		)
			.bind(await encryptToken("access-token", KEY))
			.run();

	const pair = await keyPair();
	const kid = crypto.randomUUID();
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	const sha = hex(await sha256(item.body));

	const signed = `${b64Text(JSON.stringify({ alg: "ES256", kid }))}.${b64Text(
		JSON.stringify({
			iat: Math.floor(Date.now() / 1000),
			request_body_sha256: sha,
		}),
	)}`;

	const signature = new Uint8Array(
		await crypto.subtle.sign(
			{ name: "ECDSA", hash: "SHA-256" },
			pair.privateKey,
			encoder.encode(signed),
		),
	);

	const calls: string[] = [];

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname;
			calls.push(path);

			if (path === "/webhook_verification_key/get")
				return item.token === "key-down"
					? new Response(null, { status: 500 })
					: Response.json({ key: { ...jwk, expired_at: null } });

			if (path === "/accounts/get") return Response.json({ accounts: [] });

			return Response.json({
				added: [],
				modified: [],
				removed: [],
				next_cursor: "c",
				has_more: false,
			});
		}),
	);

	const headers: Record<string, string> = {
		"content-type": "application/json",
	};

	if (item.token === "bad") headers["Plaid-Verification"] = "bad";
	else if (item.token !== "none")
		headers["Plaid-Verification"] = `${signed}.${b64(signature)}`;

	const promises: Promise<unknown>[] = [];
	const ctx = createExecutionContext();

	ctx.waitUntil = (promise) => {
		promises.push(promise);
	};

	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const error = vi.spyOn(console, "error").mockImplementation(() => {});

	try {
		const response = await app.request(
			"http://tally.test/webhooks/plaid",
			{ method: "POST", body: item.body, headers },
			env,
			ctx,
		);

		await Promise.all(promises);

		const row = await env.DB.prepare(
			"SELECT status, attention_login, attention_held, disconnected_at IS NOT NULL AS gone FROM plaid_items",
		).first();

		return `${response.status} | ${JSON.stringify(row)} | ${calls.join(",")}`;
	} catch (thrown) {
		return `throws ${errorClass(thrown)} | ${calls.join(",")}`;
	} finally {
		log.mockRestore();
		error.mockRestore();
		vi.unstubAllGlobals();
	}
}

export async function answerOf(item: EdgeCase): Promise<string> {
	if (item.site === "token") return tokenAnswer(item);

	if (item.site === "key") return keyAnswer(item);

	return bodyAnswer(item);
}

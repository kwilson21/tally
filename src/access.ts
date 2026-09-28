export type AccessEnv = {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
};

type Header = { alg?: unknown; kid?: unknown; crit?: unknown };
type Claims = {
	aud?: unknown;
	iss?: unknown;
	exp?: unknown;
	nbf?: unknown;
	email?: unknown;
};
type AccessKey = JsonWebKey & { kid?: string };
type Certs = { keys?: AccessKey[] };
type CachedCerts = { fetchedAt: number; keys: AccessKey[] };

const CERT_TTL_MS = 60 * 60 * 1000;
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30 * 1000;
const LEEWAY_SECONDS = 60;
const certCache = new Map<string, CachedCerts>();
const certFetches = new Map<string, Promise<AccessKey[]>>();
const TEAM_DOMAIN = /^[a-z0-9-]+\.cloudflareaccess\.com$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decode(part: string): Uint8Array {
	if (!BASE64URL.test(part) || part.length % 4 === 1) {
		throw new Error("Invalid base64url");
	}
	const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function json<T>(part: string): T {
	return JSON.parse(new TextDecoder().decode(decode(part))) as T;
}

async function certs(domain: string, force = false): Promise<AccessKey[]> {
	const cached = certCache.get(domain);
	const age = cached ? Date.now() - cached.fetchedAt : undefined;
	if (
		cached &&
		((!force && age !== undefined && age < CERT_TTL_MS) ||
			(force && age !== undefined && age <= UNKNOWN_KID_REFRESH_COOLDOWN_MS))
	) {
		return cached.keys;
	}
	const inFlight = certFetches.get(domain);
	if (inFlight) return inFlight;

	const fetchPromise = (async () => {
		const response = await fetch(`https://${domain}/cdn-cgi/access/certs`, {
			redirect: "error",
		});
		if (!response.ok)
			throw new Error("Cloudflare Access certs were unavailable");
		const body = (await response.json()) as Certs;
		if (!Array.isArray(body.keys))
			throw new Error("Cloudflare Access certs were invalid");
		certCache.set(domain, { fetchedAt: Date.now(), keys: body.keys });
		return body.keys;
	})();
	certFetches.set(domain, fetchPromise);
	try {
		return await fetchPromise;
	} finally {
		certFetches.delete(domain);
	}
}

function matchingKey(keys: AccessKey[], kid: string) {
	return keys.find((key) => key.kid === kid);
}

/** Logs which check refused a sign-in, so `wrangler tail` shows it. Never the token, its claims or the email. */
function refuse(reason: string): null {
	console.warn(`Access sign-in refused: ${reason}`);
	return null;
}

/** Returns the email from a valid Cloudflare Access application token, or null. */
export async function verifiedEmail(
	request: Request,
	env: AccessEnv,
): Promise<string | null> {
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	const domain = env.ACCESS_TEAM_DOMAIN;
	const expectedAudience = env.ACCESS_AUD;
	if (!token) return refuse("no Cf-Access-Jwt-Assertion header");
	if (!domain) return refuse("ACCESS_TEAM_DOMAIN isn't set");
	if (!expectedAudience) return refuse("ACCESS_AUD isn't set");
	if (!TEAM_DOMAIN.test(domain)) {
		return refuse(
			`ACCESS_TEAM_DOMAIN should look like team.cloudflareaccess.com (${domain.length} characters set)`,
		);
	}

	try {
		const parts = token.split(".");
		if (parts.length !== 3 || parts.some((part) => !BASE64URL.test(part))) {
			return refuse("the token isn't a well-formed JWT");
		}
		const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] =
			parts;
		const header = json<Header>(encodedHeader);
		if (
			header.alg !== "RS256" ||
			typeof header.kid !== "string" ||
			header.crit !== undefined
		) {
			return refuse("the token's header isn't RS256 with a key id");
		}

		// Either fetch can fail: the first, or the refresh for a key id the cache doesn't have.
		let jwk: AccessKey | undefined;
		try {
			jwk = matchingKey(await certs(domain), header.kid);
			jwk ??= matchingKey(await certs(domain, true), header.kid);
		} catch (error) {
			return refuse(
				`couldn't fetch the signing keys from https://${domain}/cdn-cgi/access/certs (${error instanceof Error ? `${error.name}: ${error.message}` : "unknown error"})`,
			);
		}
		if (!jwk) return refuse("no signing key matches the token's key id");

		const key = await crypto.subtle.importKey(
			"jwk",
			jwk,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		const validSignature = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			decode(encodedSignature),
			new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
		);
		if (!validSignature) return refuse("the token's signature doesn't verify");

		const claims = json<Claims>(encodedClaims);
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		const now = Math.floor(Date.now() / 1000);
		if (!audiences.includes(expectedAudience)) {
			return refuse(
				`the token's audience doesn't match ACCESS_AUD (${expectedAudience.length} characters set)`,
			);
		}
		if (claims.iss !== `https://${domain}`) {
			return refuse(`the token's issuer isn't https://${domain}`);
		}
		if (
			typeof claims.exp !== "number" ||
			!Number.isFinite(claims.exp) ||
			claims.exp < now - LEEWAY_SECONDS ||
			(claims.nbf !== undefined &&
				(typeof claims.nbf !== "number" ||
					!Number.isFinite(claims.nbf) ||
					claims.nbf > now + LEEWAY_SECONDS))
		) {
			return refuse("the token has expired or isn't valid yet");
		}
		if (typeof claims.email !== "string" || claims.email.length === 0) {
			return refuse("the token has no email");
		}
		return claims.email.toLowerCase();
	} catch (error) {
		// Only the error's kind: a parse error's message could quote part of the token.
		return refuse(
			`the token couldn't be checked (${error instanceof Error ? error.name : "unknown error"})`,
		);
	}
}

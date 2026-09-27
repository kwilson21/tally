export type AccessEnv = {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
};

type Header = { alg?: unknown; kid?: unknown };
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
const LEEWAY_SECONDS = 60;
const certCache = new Map<string, CachedCerts>();

function decode(part: string): Uint8Array {
	const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function json<T>(part: string): T {
	return JSON.parse(new TextDecoder().decode(decode(part))) as T;
}

async function certs(domain: string, force = false): Promise<AccessKey[]> {
	const cached = certCache.get(domain);
	if (!force && cached && Date.now() - cached.fetchedAt < CERT_TTL_MS) {
		return cached.keys;
	}
	const response = await fetch(`https://${domain}/cdn-cgi/access/certs`);
	if (!response.ok) throw new Error("Cloudflare Access certs were unavailable");
	const body = (await response.json()) as Certs;
	if (!Array.isArray(body.keys))
		throw new Error("Cloudflare Access certs were invalid");
	certCache.set(domain, { fetchedAt: Date.now(), keys: body.keys });
	return body.keys;
}

function matchingKey(keys: AccessKey[], kid: string) {
	return keys.find((key) => key.kid === kid);
}

/** Returns the email from a valid Cloudflare Access application token, or null. */
export async function verifiedEmail(
	request: Request,
	env: AccessEnv,
): Promise<string | null> {
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	const domain = env.ACCESS_TEAM_DOMAIN;
	const expectedAudience = env.ACCESS_AUD;
	if (!token || !domain || !expectedAudience) return null;

	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const [encodedHeader = "", encodedClaims = "", encodedSignature = ""] =
			parts;
		const header = json<Header>(encodedHeader);
		if (header.alg !== "RS256" || typeof header.kid !== "string") return null;

		let keys = await certs(domain);
		let jwk = matchingKey(keys, header.kid);
		if (!jwk) {
			keys = await certs(domain, true);
			jwk = matchingKey(keys, header.kid);
		}
		if (!jwk) return null;

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
		if (!validSignature) return null;

		const claims = json<Claims>(encodedClaims);
		const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		const now = Math.floor(Date.now() / 1000);
		if (
			!audiences.includes(expectedAudience) ||
			claims.iss !== `https://${domain}` ||
			typeof claims.exp !== "number" ||
			claims.exp < now - LEEWAY_SECONDS ||
			(claims.nbf !== undefined &&
				(typeof claims.nbf !== "number" ||
					claims.nbf > now + LEEWAY_SECONDS)) ||
			typeof claims.email !== "string" ||
			claims.email.length === 0
		) {
			return null;
		}
		return claims.email.toLowerCase();
	} catch {
		// Authentication failures are deliberately indistinguishable and never expose the token.
		return null;
	}
}

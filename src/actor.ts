/** Who is making a change, recorded in updated_by. #22 replaces this with the email from the verified Cloudflare Access token. */
export function actor(_env: Env): string {
	return "demo";
}

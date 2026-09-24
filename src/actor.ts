/**
 * Who is making a change, recorded in updated_by. In the demo it's "demo" (spec §5). Anywhere else
 * it throws, so no edit is saved under the wrong name before #22 adds the verified Cloudflare Access email.
 */
export function actor(env: Env): string {
	if (env.DEMO === "true") return "demo";
	throw new Error(
		"No verified identity yet: #22 adds the Cloudflare Access email.",
	);
}

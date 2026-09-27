type ActorContext = {
	env: { DEMO: string };
	get(key: "actor"): string | undefined;
};

/** Who is making a change, as established by the Access middleware. */
export function actor(c: ActorContext): string {
	if (c.env.DEMO === "true") return "demo";
	const email = c.get("actor");
	if (email) return email;
	throw new Error("No verified Cloudflare Access identity.");
}

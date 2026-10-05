import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { ErrorPage } from "./views/error-page";
import { Layout } from "./views/layout";

type App = { Bindings: Env; Variables: { actor: string } };

/** The address that was asked for, which a person can load again. */
const addressOf = (c: Context<App>) => c.req.path + new URL(c.req.url).search;

/**
 * Where the 500 page's Try again goes, or nothing when no safe place is known. A GET tries its own
 * address again. Any other method can't (a form post's address is often a 404 when fetched), so it
 * goes back to the page the form was on: the Referer's path and query, only when the Referer is
 * this site's. A path that starts with "//" is never used, since it would leave the site.
 */
export function retryHref(
	method: string,
	url: string,
	referer: string | undefined,
): string | undefined {
	const here = new URL(url);
	let from = here;
	if (method !== "GET") {
		if (!referer) return undefined;
		try {
			from = new URL(referer);
		} catch {
			return undefined;
		}
		if (from.origin !== here.origin) return undefined;
	}
	if (from.pathname.startsWith("//")) return undefined;
	return from.pathname + from.search;
}

// An htmx request swaps its reply into a part of a page, so a whole page would land inside a page:
// it gets one plain sentence, announced as an alert (spec §8.5).
const isHtmx = (c: Context<App>) => Boolean(c.req.header("HX-Request"));

/** The app's own 404: any address nothing answers, and any route that reports a missing record. */
export const notFoundPage: NotFoundHandler<App> = (c) => {
	if (isHtmx(c)) return c.html(<p role="alert">This page isn't here.</p>, 404);
	return c.html(
		<Layout
			title="Page not found · Tally"
			demo={c.env.DEMO === "true"}
			currentPath={addressOf(c)}
		>
			<ErrorPage kind="404" />
		</Layout>,
		404,
	);
};

/**
 * The app's own 500: any error nothing else caught. It never shows what failed, and it logs only
 * the error's name and the route's pattern, never its message (which can carry a token, a name or
 * an amount) or the address (which can carry an id).
 */
export const serverErrorPage: ErrorHandler<App> = (err, c) => {
	// An exception that carries its own response, such as the 403 for a form post from another site.
	if (err instanceof HTTPException) {
		const res = err.getResponse();
		return c.newResponse(res.body, res);
	}
	console.error(
		`error: ${err instanceof Error ? err.name : "unknown"} ${c.req.method} ${routePath(c, -1)}`,
	);
	if (isHtmx(c)) {
		return c.html(<p role="alert">Something went wrong on our side.</p>, 500);
	}
	return c.html(
		<Layout
			title="Something went wrong · Tally"
			demo={c.env.DEMO === "true"}
			currentPath={addressOf(c)}
		>
			<ErrorPage
				kind="500"
				retryHref={retryHref(c.req.method, c.req.url, c.req.header("Referer"))}
			/>
		</Layout>,
		500,
	);
};

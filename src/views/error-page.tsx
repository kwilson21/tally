import { Button } from "./button";
import { LedgerIllustration } from "./illustration";

type ErrorPageProps =
	| { kind: "404" }
	/** The 500 page's Try again loads this address; without one, there is no Try again. */
	| { kind: "500"; retryHref?: string };

/**
 * The page for a link that goes nowhere (404) or a mistake on Tally's side (500), drawn inside the
 * Layout so the navigation is there and nobody is stuck (decision 72, P39 C). It never shows what
 * failed: no message, no code, nothing from the request.
 */
export function ErrorPage(props: ErrorPageProps) {
	return (
		<div class="mt-8 flex flex-col items-center text-center">
			<div class="[&>svg]:size-44">
				<LedgerIllustration />
			</div>
			<h1 class="mt-4 font-serif text-7xl font-semibold tracking-tight">
				<span class="sr-only">Error </span>
				{props.kind}
			</h1>
			{props.kind === "404" ? (
				<>
					<p class="mt-2 text-lg">This page isn't here.</p>
					<div class="mt-4">
						<Button kind="secondary" href="/">
							Go to Home
						</Button>
					</div>
				</>
			) : (
				<>
					<p class="mt-2 text-lg">Something went wrong on our side.</p>
					<p class="mt-1 max-w-xs text-muted">
						Nothing you did. Your data is safe; try again in a minute.
					</p>
					<div class="mt-4 flex flex-wrap items-center justify-center gap-3">
						{props.retryHref ? (
							<>
								<Button kind="secondary" href={props.retryHref}>
									Try again
								</Button>
								<Button kind="text" href="/">
									Go to Home
								</Button>
							</>
						) : (
							<Button kind="secondary" href="/">
								Go to Home
							</Button>
						)}
					</div>
				</>
			)}
		</div>
	);
}

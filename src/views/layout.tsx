import type { Child } from "hono/jsx";
import { Wordmark } from "./brand";
import { FeedbackButton } from "./feedback-button";
import { BottomTabs, type NavKey, Sidebar } from "./nav";

type LayoutProps = {
	title?: string;
	active?: NavKey;
	demo: boolean;
	/** Extra scripts for this page only (the catalog's ds.js, decision 44). */
	scripts?: string[];
	/** Extra ES module scripts for this page only. */
	modules?: string[];
	currentPath?: string;
	children?: Child;
};

/**
 * The demo's line above every page, at every width, with Start here as its one ink link: the first section of
 * How Tally works (spec §8.8, P124 A, #549). The family app has none.
 */
export function DemoBanner() {
	return (
		<p class="bg-band py-2 text-center text-sm text-muted">
			Demo data. Nothing here is real. ·{" "}
			<a
				href="/how-it-works#start-here"
				class="inline-flex min-h-11 items-center font-medium text-ink underline underline-offset-4"
			>
				Start here
			</a>
		</p>
	);
}

export function Layout({
	title = "Tally",
	active,
	demo,
	scripts = [],
	modules = [],
	currentPath = "/",
	children,
}: LayoutProps) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta
					name="viewport"
					content="width=device-width, initial-scale=1, viewport-fit=cover"
				/>
				<title>{title}</title>
				{/* htmx 4 swaps every reply but 204 and 304. A 500 (an unhandled error) must not land in the page, so a sheet keeps what was typed and toast.js says what happened. Every other 4xx and 5xx still swaps: it carries its own message on purpose, such as a field's error (422) or a bank that couldn't be reached (502). defaultTimeout 0 turns htmx's own 60-second timeout off: it aborts a timed-out request exactly as it aborts a replaced one, so toast.js keeps the 60 seconds itself and can tell them apart. */}
				<meta
					name="htmx-config"
					content={JSON.stringify({
						noSwap: [204, 304, 500],
						defaultTimeout: 0,
					})}
				/>
				<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
				<link rel="stylesheet" href="/assets/app.css" />
				<script src="/vendor/htmx.min.js" defer></script>
				<script src="/js/toast.js" defer></script>
				{/* Makes an open sheet a modal: Escape, Tab stays inside it, the page behind is inert (decision 109). */}
				<script src="/js/sheet.js" defer></script>
				{/* The money input's nudges and chips (decision 39); module scripts are deferred. */}
				<script src="/js/money.js" type="module"></script>
				{scripts.map((src) => (
					<script src={src} defer></script>
				))}
				{modules.map((src) => (
					<script src={src} type="module"></script>
				))}
			</head>
			<body class="min-h-screen pt-[var(--safe-area-top)]">
				<a
					href="#main"
					class="sr-only focus:not-sr-only focus:absolute focus:left-[calc(1rem+var(--safe-area-left))] focus:top-[calc(1rem+var(--safe-area-top))] focus:bg-paper focus:p-2"
				>
					Skip to content
				</a>
				{demo && <DemoBanner />}
				<div class="mx-auto flex max-w-6xl gap-10 px-5 pl-[calc(1.25rem+var(--safe-area-left))] pr-[calc(1.25rem+var(--safe-area-right))] lg:px-8">
					<aside class="hidden w-56 shrink-0 py-8 lg:block">
						<div class="mb-8">
							<Wordmark />
						</div>
						<Sidebar active={active} currentPath={currentPath} />
					</aside>
					<main
						id="main"
						class="min-w-0 flex-1 pb-[var(--focus-scroll-room)] pt-6 lg:pb-24 lg:pt-8"
					>
						<div
							id="top-line"
							class="mb-2 flex items-center justify-between gap-3 lg:hidden"
						>
							<Wordmark />
							{!currentPath.startsWith("/feedback") && <FeedbackButton />}
						</div>
						{children}
					</main>
				</div>
				<BottomTabs active={active} />
				{/* z-60: above the BottomSheet (z-50), so a failed save's toast shows over an open sheet. Taps pass through it, so a toast over Save never eats the tap that tries again. Toasts sit in the frame, never over the page (decision 101): on a phone 12 px above the tab bar and its safe area, at the top edge while a sheet is open (a sheet drawn inside an inert frame, as the catalog's are, doesn't count), and 12 px above the Select bar's real height in Select mode; on desktop 24 px from the bottom, beside the sidebar and no wider than it. */}
				<div
					id="toasts"
					class="pointer-events-none fixed inset-x-4 z-60 flex flex-col items-center gap-2 bottom-[calc(var(--tabs-height)+var(--safe-area-bottom)+0.75rem)] max-lg:[body:has([role=dialog]:not([inert]_*))_&]:top-[calc(0.75rem+var(--safe-area-top))] max-lg:[body:has([role=dialog]:not([inert]_*))_&]:bottom-auto max-lg:[body:has(#selection-form):not(:has([role=dialog]:not([inert]_*)))_&]:bottom-[calc(var(--tabs-height)+var(--safe-area-bottom)+var(--selection-bar-height)+0.75rem)] lg:bottom-6 lg:left-[max(2rem,calc(50%_-_34rem))] lg:right-auto lg:w-56 lg:items-start"
				/>
				<div
					id="announcer"
					class="sr-only"
					aria-live="polite"
					aria-atomic="true"
				/>
			</body>
		</html>
	);
}

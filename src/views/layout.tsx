import type { Child } from "hono/jsx";
import { Wordmark } from "./brand";
import { BottomTabs, type NavKey, Sidebar } from "./nav";

type LayoutProps = {
	title?: string;
	active?: NavKey;
	demo: boolean;
	children?: Child;
};

export function Layout({
	title = "Tally",
	active,
	demo,
	children,
}: LayoutProps) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
				<link rel="stylesheet" href="/assets/app.css" />
				<script src="/vendor/htmx.min.js" defer></script>
				<script src="/js/toast.js" defer></script>
			</head>
			<body class="min-h-screen">
				<a
					href="#main"
					class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:bg-paper focus:p-2"
				>
					Skip to content
				</a>
				{demo && (
					<p class="bg-band py-2 text-center text-sm text-muted">
						Demo data. Nothing here is real.
					</p>
				)}
				<div class="mx-auto flex max-w-6xl gap-10 px-5 lg:px-8">
					<aside class="hidden w-56 shrink-0 py-8 lg:block">
						<div class="mb-8">
							<Wordmark />
						</div>
						<Sidebar active={active} />
					</aside>
					<main id="main" class="min-w-0 flex-1 pb-24 pt-6 lg:pb-12 lg:pt-8">
						<div class="mb-4 lg:hidden">
							<Wordmark />
						</div>
						{children}
					</main>
				</div>
				<BottomTabs active={active} />
				<div
					id="toasts"
					class="fixed inset-x-4 bottom-20 flex flex-col items-center gap-2 lg:bottom-6"
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

// The busy ring: a spinning arc that shows work in progress (Button's busy label, and a bank being read in Home's Your
// banks list). Its class is what app.css stops for reduced motion (`.button-spinner`), so every ring stops the same way.

/** The ring, muted by its parent's text colour; hidden from assistive technology, which hears the words beside it. */
export function BusyRing() {
	return (
		<svg
			class="button-spinner size-4"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="3"
			aria-hidden="true"
		>
			<circle cx="12" cy="12" r="9" opacity="0.25" />
			<path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round" />
		</svg>
	);
}

import { Button } from "./button";

/**
 * The quiet line under the edit panel's category chips on a trip that looks mixed (#233, decision 113): the two
 * categories Jev named, then "Split this one?" in terracotta, whose link opens the split with Tally's guesses.
 */
export function MixedTripLine({
	first,
	second,
	href,
}: {
	first: string;
	second: string;
	href: string;
}) {
	return (
		<p class="flex flex-wrap items-center gap-x-1 text-sm text-muted">
			{`This trip looks like ${first} and ${second}.`}
			<Button kind="text" href={href} class="-ml-2 text-sm">
				Split this one?
			</Button>
		</p>
	);
}

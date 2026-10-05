// Home's top (#92, decision 46 P1): what's safe to spend is the one thing, so on a phone it's on the
// first screen. The month is a small heading above it, the status sentence says what it means, and the
// Band is the one next action. Things to try and the Budget list come after, in the route.
import { formatCents } from "../money";
import { Band } from "./band";
import { HowLink } from "./how-link";
import { LedgerIllustration } from "./illustration";

type Props = {
	/** "September" */
	month: string;
	safeToSpendCents: number;
	/** The status sentence: "Eating Out is $36 over. Everything else is on track." */
	status: string;
	demo: boolean;
	/** The one next action, when there is one: "12 transactions need a category", and its amount (decision 50). */
	band?: { href: string; text: string; detail?: string };
};

/** The month, then Safe to spend, the status sentence, How this works (demo only) and the Band. */
export function HomeTop({
	month,
	safeToSpendCents,
	status,
	demo,
	band,
}: Props) {
	return (
		<>
			<h1 class="font-serif text-2xl font-semibold tracking-tight">{month}</h1>
			<div class="mt-2 flex items-center justify-between gap-6">
				<div>
					<p class="text-lg text-muted">Safe to spend</p>
					<p class="font-serif text-6xl font-semibold tracking-tight lg:text-7xl">
						{formatCents(safeToSpendCents, { wholeDollars: true })}
					</p>
				</div>
				<LedgerIllustration />
			</div>
			<p class="mt-3 font-serif text-lg italic">{status}</p>
			<HowLink section="budget" demo={demo} />
			{band && (
				<div class="mt-4">
					<Band href={band.href} detail={band.detail}>
						{band.text}
					</Band>
				</div>
			)}
		</>
	);
}

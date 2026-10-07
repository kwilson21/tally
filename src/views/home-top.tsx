// Home's top (#92, decision 46 P1): what's safe to spend is the one thing, so on a phone it's on the
// first screen. The month is a small heading above it, Why? explains the amount, the status sentence
// says what it means, and the Band is the one next action. Things to try and the Budget list follow.
import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import { Band } from "./band";
import { BankBehind } from "./bank-line";
import { HowLink } from "./how-link";
import { LedgerIllustration } from "./illustration";
import { WhyLink } from "./why-link";

type Props = {
	/** "September" */
	month: string;
	monthHeading?: Child;
	safeToSpendCents: number;
	/** The status sentence: "Eating Out is $36 over. Everything else is on track." */
	status: string;
	/** Each connected bank that needs attention, in words (src/stale-bank.ts). */
	bankLine?: string[];
	/** The short date printed in the as-of tag. */
	bankDate?: string;
	dailyAmount?: string;
	forecast?: Child;
	/** Finished months are read-only and never show current-month alerts or projections. */
	currentMonth?: boolean;
	/** The one next action, when there is one, and its amount (decision 50). */
	band?: { href: string; text: Child; detail?: string; older?: number };
};

/** The month, then Safe to spend, the status sentence, How this works, a stale-bank line when needed, and the Band. */
export function HomeTop({
	month,
	monthHeading,
	safeToSpendCents,
	status,
	bankLine,
	band,
	bankDate,
	dailyAmount,
	forecast,
	currentMonth = true,
}: Props) {
	const over = safeToSpendCents < 0;
	const amount = over
		? `−${formatCents(-safeToSpendCents, { wholeDollars: -safeToSpendCents >= 100 })}`
		: formatCents(safeToSpendCents, { wholeDollars: true });
	return (
		<>
			{monthHeading ?? (
				<h1 class="font-serif text-2xl font-semibold tracking-tight">
					{month}
				</h1>
			)}
			<div class="mt-2 flex items-center justify-between gap-6">
				<div>
					<p class="text-lg text-muted">
						Safe to spend · <WhyLink section="budget" topic="safe to spend" />
					</p>
					<p
						class={`font-serif text-6xl font-semibold tracking-tight lg:text-7xl ${over ? "text-over" : ""}`}
					>
						{amount}
						{currentMonth && bankDate && (
							<span class="ml-3 inline-flex min-h-8 items-center rounded-full border border-dashed border-muted px-3 align-middle font-sans text-sm font-normal text-muted">
								as of {bankDate}
							</span>
						)}
					</p>
				</div>
				<LedgerIllustration />
			</div>
			<p class="mt-3 font-serif text-lg italic">
				{over
					? "Over budget this month. Spending more takes it further over."
					: status}
			</p>
			{currentMonth && bankLine && <BankBehind words={bankLine} />}
			{currentMonth && dailyAmount && (
				<p class="mt-1 text-muted">{dailyAmount}</p>
			)}
			{currentMonth && forecast}
			<HowLink section="budget" />
			{band && (
				<div class={bankLine ? "mt-2" : "mt-4"}>
					<Band href={band.href} detail={band.detail} older={band.older}>
						{band.text}
					</Band>
				</div>
			)}
		</>
	);
}

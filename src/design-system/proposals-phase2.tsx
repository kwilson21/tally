// P13 and P14 (decisions 57 and 58): Download your data and Send feedback, drawn on a phone's first
// screen from the real components for the owner's sign-off. P10–P12 are decided (decision 59).

import type { Child } from "hono/jsx";
import { Button } from "../views/button";
import { Chip } from "../views/chip";
import { Icon } from "../views/icons";
import { PhoneFrame, Specimen } from "./specimen";

type Option = { name: string; note: string; screen: Child };

/** A proposal's options side by side, each named and noted above its phone. */
function Options({ options }: { options: Option[] }) {
	return (
		<div class="flex flex-wrap gap-8">
			{options.map((o) => (
				<div class="flex w-[392px] max-w-full flex-col gap-2">
					<h4 class="font-semibold">{o.name}</h4>
					<p class="min-h-18 text-sm text-muted">{o.note}</p>
					<PhoneFrame label={`${o.name}, on a phone`}>{o.screen}</PhoneFrame>
				</div>
			))}
		</div>
	);
}

function Title({ children }: { children?: Child }) {
	return (
		<h1 class="font-serif text-4xl font-semibold tracking-tight">{children}</h1>
	);
}

/** P13: a section at the end of Settings with two downloads. */
const exportSection = (
	<>
		<Title>Settings</Title>
		<p class="mt-4 text-muted">Categories, merchants…</p>
		<section class="mt-8 border-t border-rule pt-6">
			<h2 class="text-2xl">Your data</h2>
			<p class="mt-1 text-muted">
				Everything Tally has stored, to keep or open elsewhere. Bank logins are
				never included.
			</p>
			<div class="mt-4 flex flex-col items-start gap-3">
				<Button kind="secondary" href="#p13-export">
					Download transactions (CSV)
				</Button>
				<Button kind="secondary" href="#p13-export">
					Download everything (JSON)
				</Button>
			</div>
		</section>
	</>
);

const FACES = ["Frustrated", "Confused", "Okay", "Happy", "Delighted"];

/** P14: the form (type, face, message). */
const feedbackForm = (
	<>
		<Title>Send feedback</Title>
		<p class="mt-2 text-muted">Goes straight to the person who builds Tally.</p>
		<div class="mt-5 flex flex-col gap-4">
			<fieldset class="flex flex-col gap-2">
				<legend class="text-base text-ink">What is it?</legend>
				<div class="flex flex-wrap gap-2">
					{["Bug", "Idea", "Question", "Other"].map((t, i) => (
						<Chip type="radio" name="p14-type" value={t} checked={i === 0}>
							{t}
						</Chip>
					))}
				</div>
			</fieldset>
			<fieldset class="flex flex-col gap-2">
				<legend class="text-base text-ink">
					How does Tally feel right now?
				</legend>
				<div class="flex flex-wrap gap-2">
					{FACES.map((f, i) => (
						<Chip type="radio" name="p14-face" value={f} checked={i === 1}>
							{f}
						</Chip>
					))}
				</div>
			</fieldset>
			<label class="flex flex-col gap-1">
				<span class="text-base text-ink">Message</span>
				<textarea class="min-h-28 rounded-control border border-rule bg-band p-3 text-lg">
					The Target total looks doubled this month.
				</textarea>
			</label>
			<div>
				<Button type="button">Send</Button>
			</div>
		</div>
	</>
);

/** P14 C: a small button pinned above the tab bar on every page, as in the original app. */
const feedbackCorner = (
	<div class="relative h-[640px]">
		<Title>September</Title>
		<p class="mt-4 text-muted">Safe to spend</p>
		<p class="font-serif text-5xl">$283</p>
		<p class="mt-6 text-muted">The page scrolls under it; it never moves.</p>
		<span class="absolute right-0 bottom-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-rule bg-paper px-4 text-ink shadow-sm">
			<Icon name="list" class="size-5" />
			Feedback
		</span>
	</div>
);

/** The open proposals: P13 and P14. P10–P12 are decided (decision 59). */
export function Phase2Proposals() {
	return (
		<>
			<Specimen
				id="p13-export"
				title="P13 · Download your data"
				tier="visual"
				sentence="A section at the end of Settings. One design; sign it off or say what to change."
			>
				<Options
					options={[
						{
							name: "Proposed · Your data",
							note: "Two downloads: transactions as CSV for a spreadsheet, and everything as JSON.",
							screen: exportSection,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p14-feedback"
				title="P14 · Send feedback"
				tier="visual"
				sentence="Filed privately to tally-feedback (decision 58). Always visible, as in the original app. Sign off the button and the form, or say what to change."
			>
				<Options
					options={[
						{
							name: "Proposed · Always in the corner",
							note: "Pinned above the tab bar on every page (CSS only, no script), so it's there however long the page is or whatever went wrong. The page it came from is attached.",
							screen: feedbackCorner,
						},
						{
							name: "The form",
							note: "Type, how it feels, and a message. The server adds the page and device.",
							screen: feedbackForm,
						},
					]}
				/>
			</Specimen>
		</>
	);
}

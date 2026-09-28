// P10–P14 (decisions 57 and 58): the five features joining Phase 2, each option drawn on a phone's
// first screen from the real components, so the owner signs them all off in one pass.

import type { Child } from "hono/jsx";
import { formatCents } from "../money";
import { AccountRow } from "../views/account-row";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { Chip } from "../views/chip";
import { Icon } from "../views/icons";
import { TextInput } from "../views/text-input";
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

const CATEGORIES = [
	{ id: "1", name: "Groceries", icon: "groceries", color: "cat-blue" },
	{ id: "2", name: "Shopping", icon: "shopping", color: "cat-plum" },
	{ id: "3", name: "Eating Out", icon: "eating-out", color: "cat-ochre" },
	{ id: "4", name: "Gas", icon: "gas", color: "cat-slate" },
];

const GROUPS = [
	{
		name: "Target",
		count: 14,
		cents: 81240,
		spellings: "TARGET 1234, TARGET.COM",
	},
	{ name: "Doordash", count: 9, cents: 21433, spellings: "DD *DOORDASH" },
	{ name: "Shell", count: 6, cents: 28710, spellings: "SHELL OIL 5741" },
];

function CategoryChips({ name, checked }: { name: string; checked?: string }) {
	return (
		<div class="flex flex-wrap gap-2">
			{CATEGORIES.map((c) => (
				<Chip
					type="radio"
					name={name}
					value={c.id}
					checked={checked === c.id}
					icon={<CategoryIcon icon={c.icon} color={c.color} />}
				>
					{c.name}
				</Chip>
			))}
		</div>
	);
}

function Title({ children }: { children?: Child }) {
	return (
		<h1 class="font-serif text-4xl font-semibold tracking-tight">{children}</h1>
	);
}

/** P10 A: every group on one page, each with its own category picker and Save. */
const organizeList = (
	<>
		<Title>Organize</Title>
		<p class="mt-2 text-muted">29 transactions in 3 groups need a category.</p>
		<ul class="mt-4 divide-y divide-rule border-y border-rule">
			{GROUPS.map((g, i) => (
				<li class="py-4">
					<p class="flex items-baseline justify-between gap-3 text-lg">
						<span>{g.name}</span>
						<span class="tabular-nums">{formatCents(g.cents)}</span>
					</p>
					<p class="text-sm text-muted">{g.count} transactions</p>
					{i === 0 && (
						<div class="mt-3 flex flex-col gap-3">
							<CategoryChips name="p10a" checked="2" />
							<Button type="button">Save for all 14</Button>
						</div>
					)}
				</li>
			))}
		</ul>
	</>
);

/** P10 B: one group at a time, largest first, with a rename and a count of what's left. */
const organizeOne = (
	<>
		<Title>Organize</Title>
		<p class="mt-2 text-muted">1 of 3 · 29 transactions left</p>
		<div class="mt-6">
			<p class="text-2xl">Target</p>
			<p class="text-muted">14 transactions · {formatCents(81240)}</p>
			<p class="mt-1 text-sm text-muted">From TARGET 1234, TARGET.COM</p>
		</div>
		<div class="mt-5 flex flex-col gap-4">
			<fieldset class="flex flex-col gap-2">
				<legend class="text-base text-ink">Category</legend>
				<CategoryChips name="p10b" checked="2" />
			</fieldset>
			<TextInput id="p10b-name" label="Name (optional)" value="Target" />
			<div class="flex items-center gap-3">
				<Button type="button">Save and next</Button>
				<Button kind="text" type="button">
					Skip
				</Button>
			</div>
			<p class="text-sm text-muted">
				Future Target transactions get this category too.
			</p>
		</div>
	</>
);

function Bank({
	name,
	synced,
	children,
}: {
	name: string;
	synced?: string;
	children?: Child;
}) {
	return (
		<section class="mt-6">
			<h2 class="text-muted">{name}</h2>
			{synced && <p class="text-sm text-muted">{synced}</p>}
			<ul class="mt-2 divide-y divide-rule border-y border-rule">
				<AccountRow
					name="Checking"
					mask="4410"
					type="depository"
					balanceCents={421055}
					isLiability={false}
				/>
			</ul>
			{children}
		</section>
	);
}

/** P11 A: a quiet text action under each bank. */
const disconnectLink = (
	<>
		<Title>Accounts</Title>
		<Bank name="First Harbor Bank">
			<Button kind="text" type="button" class="mt-2 -ml-2">
				Disconnect
			</Button>
		</Bank>
	</>
);

/** P11 B: tucked behind a Manage disclosure, so it's two taps away. */
const disconnectManage = (
	<>
		<Title>Accounts</Title>
		<Bank name="First Harbor Bank">
			<details open class="mt-2">
				<summary class="inline-flex min-h-11 cursor-pointer items-center text-accent">
					Manage
				</summary>
				<Button kind="secondary" type="button" class="mt-1">
					Disconnect this bank
				</Button>
			</details>
		</Bank>
	</>
);

/** P11, both options: the confirm step (decision 58: history kept by default). */
const disconnectConfirm = (
	<>
		<Title>Disconnect First Harbor Bank?</Title>
		<p class="mt-4 text-lg">
			Tally stops syncing it. Its 2 accounts and 184 transactions stay, so past
			months still add up.
		</p>
		<div class="mt-5">
			<Chip type="checkbox" name="p11-delete" value="1">
				Also delete its accounts and transactions
			</Chip>
		</div>
		<div class="mt-6 flex items-center gap-3">
			<Button type="button">Disconnect</Button>
			<Button kind="text" type="button">
				Cancel
			</Button>
		</div>
	</>
);

/** P12 A: one button under the title; each bank says when it last synced. */
const syncButton = (
	<>
		<Title>Accounts</Title>
		<div class="mt-4">
			<Button kind="secondary" type="button">
				Sync now
			</Button>
		</div>
		<Bank name="First Harbor Bank" synced="Synced 12 minutes ago" />
		<Bank name="Northline Card Services" synced="Synced 3 hours ago" />
	</>
);

/** P12 B: one quiet line under the title, with the action as a link. */
const syncLine = (
	<>
		<Title>Accounts</Title>
		<p class="mt-3 flex flex-wrap items-center gap-x-2 text-muted">
			Synced 12 minutes ago ·
			<Button kind="text" type="button" class="-ml-2">
				Sync now
			</Button>
		</p>
		<Bank name="First Harbor Bank" />
		<Bank name="Northline Card Services" />
	</>
);

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

/** P14, both options: the form (type, face, message). */
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

/** P14 A: a quiet link at the end of every page. */
const feedbackFooter = (
	<>
		<Title>September</Title>
		<p class="mt-4 text-muted">Safe to spend</p>
		<p class="font-serif text-5xl">$283</p>
		<div class="mt-72 border-t border-rule pt-4 text-center">
			<a href="#p14-feedback" class="inline-flex min-h-11 items-center gap-2">
				Send feedback
			</a>
		</div>
	</>
);

/** P14 B: in More, as its own row next to Accounts and Settings. */
const feedbackMore = (
	<>
		<Title>More</Title>
		<ul class="mt-4 divide-y divide-rule border-y border-rule">
			{[
				["accounts", "Accounts"],
				["documents", "Documents"],
				["settings", "Settings"],
				["list", "Send feedback"],
			].map(([icon, label]) => (
				<li class="flex h-14 items-center gap-4 text-lg">
					<Icon name={icon as "list"} class="size-6" />
					<span class="flex-1">{label}</span>
					<Icon name="chevron-right" />
				</li>
			))}
		</ul>
	</>
);

/** The five open proposals, P10–P14. */
export function Phase2Proposals() {
	return (
		<>
			<Specimen
				id="p10-organize"
				title="P10 · Organize"
				tier="visual"
				sentence="Sort the backlog by merchant: one category choice covers a whole group and becomes its rule. Pick how a person moves through the groups."
			>
				<Options
					options={[
						{
							name: "Option A · All groups on one page",
							note: "Every group listed, largest first; tap one to open its picker. Fast when there are many; busier.",
							screen: organizeList,
						},
						{
							name: "Option B · One group at a time",
							note: "The biggest group, its picker and an optional rename, then Save and next. Calmer and harder to get lost in.",
							screen: organizeOne,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p11-disconnect"
				title="P11 · Disconnect a bank"
				tier="visual"
				sentence="History stays by default (decision 58). Pick where the action lives; the confirm step is the same for both."
			>
				<Options
					options={[
						{
							name: "Option A · A quiet link under each bank",
							note: "Always visible, in the text-action style. One tap to the confirm step.",
							screen: disconnectLink,
						},
						{
							name: "Option B · Behind Manage",
							note: "Out of sight until wanted, so it can't be tapped by accident. Two taps to the confirm step.",
							screen: disconnectManage,
						},
						{
							name: "Both · The confirm step",
							note: "Names the bank and what stays; deleting is an opt-in tick.",
							screen: disconnectConfirm,
						},
					]}
				/>
			</Specimen>

			<Specimen
				id="p12-sync"
				title="P12 · Sync now"
				tier="visual"
				sentence="Syncs every bank now and says what came in. Pick how it sits on Accounts."
			>
				<Options
					options={[
						{
							name: "Option A · A button, and a time per bank",
							note: "Clear and findable; each bank says when it last synced, which helps spot a stuck one.",
							screen: syncButton,
						},
						{
							name: "Option B · One quiet line",
							note: "One time for all banks and a text link. Lighter; a stuck bank is less visible.",
							screen: syncLine,
						},
					]}
				/>
			</Specimen>

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
				sentence="Filed privately to tally-feedback (decision 58). Pick where the link lives; the form is the same for both."
			>
				<Options
					options={[
						{
							name: "Option A · At the end of every page",
							note: "Always one scroll away, wherever something went wrong; the page it came from is attached.",
							screen: feedbackFooter,
						},
						{
							name: "Option B · A row in More",
							note: "Out of the way; one more tap, and the page it came from is More.",
							screen: feedbackMore,
						},
						{
							name: "Both · The form",
							note: "Type, how it feels, and a message. The server adds the page and device.",
							screen: feedbackForm,
						},
					]}
				/>
			</Specimen>
		</>
	);
}

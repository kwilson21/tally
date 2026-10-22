// P141 (#770): a new family's setup, drawn for the owner's pick. Today is the setup as it is drawn now; A (recommended) gives setup
// its own pages; B keeps it on Home in plain words. Every picture is inert and labelled, like the rest of the page.

import type { Child } from "hono/jsx";
import { Band } from "../views/band";
import { Wordmark } from "../views/brand";
import { Button } from "../views/button";
import { CategoryIcon } from "../views/category";
import { FeedbackButton } from "../views/feedback-button";
import { FirstPage, SmallNotebook } from "../views/first-page";
import { Icon } from "../views/icons";
import { Notebook } from "../views/notebook";
import { type StepLine, TallySteps } from "../views/tally-steps";
import { Fixed } from "./proposal-parts";
import { Choice, Choices, Phone, Shot } from "./proposals-polish-4";
import { Specimen } from "./specimen";

// ---------------------------------------------------------------------------------------------
// Setup's own parts: a step's dot, the steps as rows, the step bar and the foot of a phone.

type StepState = "done" | "current" | "next";

type SetupStep = {
	name: string;
	benefit?: string;
	note: string;
	state: StepState;
};

/** A step's dot: a check in ink when done, its number ringed in ink when current, and in rule when next. */
function StepDot({ n, state }: { n: number; state: StepState }) {
	const base =
		"inline-flex size-7 shrink-0 items-center justify-center rounded-full text-sm tabular-nums";
	if (state === "done")
		return (
			<span class={`${base} bg-ink text-paper`}>
				<Icon name="check" class="size-4" />
				<span class="sr-only">Step {n}, done</span>
			</span>
		);
	if (state === "current")
		return (
			<span class={`${base} border-2 border-ink font-semibold text-ink`}>
				{n}
			</span>
		);
	return <span class={`${base} border border-rule text-muted`}>{n}</span>;
}

/** The steps as ruled rows: the dot, the name and its benefit, and the note at the right. */
function SetupSteps({ steps }: { steps: SetupStep[] }) {
	return (
		<ol class="mt-6 border-t border-rule">
			{steps.map((step, i) => (
				<li class="flex items-start gap-3 border-b border-rule py-3">
					<StepDot n={i + 1} state={step.state} />
					<div class="min-w-0 flex-1">
						<p class="font-medium">{step.name}</p>
						{step.benefit && <p class="text-sm text-muted">{step.benefit}</p>}
					</div>
					<p class="shrink-0 pt-0.5 text-sm text-muted">{step.note}</p>
				</li>
			))}
		</ol>
	);
}

/** Four bars for the four steps: done in ink, the current one half ink, the rest in rule. The label says it in words too. */
function StepBar({ done, label }: { done: number; label: string }) {
	const bar = (i: number) =>
		i < done ? "bg-ink" : i === done && done < 4 ? "bg-ink/40" : "bg-rule";
	return (
		<div>
			<p class="text-sm text-muted">{label}</p>
			<div class="mt-2 grid grid-cols-4 gap-1.5" aria-hidden="true">
				{[0, 1, 2, 3].map((i) => (
					<span class={`h-1 rounded-full ${bar(i)}`} />
				))}
			</div>
		</div>
	);
}

/** The actions pinned to a phone's foot, passed as the phone's overlay. */
function Foot({ children }: { children?: Child }) {
	return (
		<div class="absolute inset-x-0 bottom-0 border-t border-rule bg-paper px-5 pb-8 pt-4">
			{children}
		</div>
	);
}

/** A's desktop picture: a window at a desktop's width, with the wordmark and no sidebar, its column centred. */
function SetupDesk({ label, children }: { label: string; children?: Child }) {
	return (
		<div class="overflow-x-auto">
			<div
				role="img"
				aria-label={`${label}, on desktop`}
				class="relative h-[840px] w-[722px] shrink-0 overflow-hidden rounded-control border border-ink bg-paper"
			>
				<div inert>
					<div data-screen="picture">
						<div class="flex items-center justify-between px-8 pt-6">
							<Wordmark />
							<FeedbackButton />
						</div>
						<div class="mx-auto max-w-md px-8 pt-6">{children}</div>
					</div>
				</div>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------------------------
// Today: the setup as it is drawn now, as literal markup, so the live words never reach this picture (P140's pattern).

const TODAY_FIRST: StepLine[] = [
	{ name: "Link your bank", done: false, note: "About a minute" },
	{ name: "Your pay", done: false, note: "One question" },
	{ name: "Your bills", done: false, note: "One question" },
	{ name: "Your budgets", done: false, note: "One tap, or one at a time" },
	{
		name: "Tomorrow · Tally keeps count on its own",
		done: false,
		note: "Later",
	},
];

const TODAY_AFTER: StepLine[] = [
	{ name: "Link your bank", done: true, note: "Chase, linked" },
	{ name: "Your pay", done: true, note: "Today, Oct 21" },
	{ name: "Your bills", done: true, note: "Today, Oct 21" },
	{ name: "Your budgets", done: true, note: "Today, Oct 21" },
	{
		name: "Tomorrow · Tally keeps count on its own",
		done: false,
		note: "Later",
	},
];

// ---------------------------------------------------------------------------------------------
// A: setup on its own pages. One body per screen, drawn on a phone and (the first and last) on a desktop.

function WelcomeBody() {
	return (
		<>
			<Notebook strokes={0} ink size="size-20" />
			<h1 class="mt-2 font-serif text-4xl font-semibold tracking-tight">
				Welcome to Tally.
			</h1>
			<p class="mt-3 text-lg">
				Tally reads your bank, sorts your spending and shows what's safe to
				spend this month.
			</p>
			<p class="mt-2 text-muted">
				Four steps, about four minutes of your time.
			</p>
			<SetupSteps
				steps={[
					{
						name: "Link your bank",
						benefit:
							"Tally reads your last 90 days, so you don't start from zero.",
						note: "About a minute",
						state: "next",
					},
					{
						name: "Your pay",
						benefit: "So Tally knows what comes in.",
						note: "One question",
						state: "next",
					},
					{
						name: "Your bills",
						benefit: "So they're set aside before you spend.",
						note: "One question",
						state: "next",
					},
					{
						name: "Your budgets",
						benefit: "Suggested from what you really spend.",
						note: "One tap",
						state: "next",
					},
				]}
			/>
		</>
	);
}

function WelcomeActions() {
	return (
		<>
			<Button type="button" class="w-full">
				Link your bank
			</Button>
			<p class="mt-3 text-center text-sm text-muted">
				Tally can only read your bank. It can't move money.
			</p>
		</>
	);
}

function ReadingBody() {
	return (
		<>
			<StepBar done={1} label="Step 1 of 4 done · Reading your bank" />
			<h1 class="mt-6 font-serif text-4xl font-semibold tracking-tight">
				Reading your bank
			</h1>
			<p class="mt-3 text-lg">
				Tally is sorting 90 days of transactions from Chase, so your questions
				use your real numbers.
			</p>
			<div class="mt-6">
				<p class="flex justify-between text-sm">
					<span>Sorted</span>
					<span class="tabular-nums">318 of 412</span>
				</p>
				<div class="mt-2 h-2 rounded-full bg-rule">
					<div class="h-2 w-[77%] rounded-full bg-ink" />
				</div>
			</div>
			<ul class="mt-6 border-y border-rule">
				<li class="flex min-h-11 items-center justify-between gap-3 py-2">
					<span>Chase</span>
					<span class="text-sm text-muted">90 days in · 412</span>
				</li>
			</ul>
			<p class="mt-6 rounded-control bg-band p-4">
				You can close this page. Tally emails you the moment your questions are
				ready.
			</p>
		</>
	);
}

function PayBody() {
	return (
		<>
			<StepBar done={1} label="Step 2 of 4 · Your pay" />
			<h1 class="mt-6 font-serif text-4xl font-semibold tracking-tight">
				Is this your pay?
			</h1>
			<p class="mt-3 text-lg text-muted">
				Tally found money that comes in regularly from one place.
			</p>
			<div class="mt-6 rounded-control border border-rule">
				<div class="px-4 py-3">
					<div class="flex items-baseline justify-between gap-3">
						<p class="font-medium">ACME CORP PAYROLL</p>
						<p class="font-serif text-2xl font-semibold tabular-nums">$2,450</p>
					</div>
					<p class="text-sm text-muted">
						Every other Friday · 7 times since Jul 17
					</p>
				</div>
				<ul class="divide-y divide-rule border-t border-rule text-sm">
					<li class="flex justify-between px-4 py-2">
						<span>Fri, Oct 9</span>
						<span class="tabular-nums">$2,450.00</span>
					</li>
					<li class="flex justify-between px-4 py-2">
						<span>Fri, Sep 25</span>
						<span class="tabular-nums">$2,450.00</span>
					</li>
					<li class="flex justify-between px-4 py-2">
						<span>Fri, Sep 11</span>
						<span class="tabular-nums">$2,450.00</span>
					</li>
					<li class="px-4 py-2 text-muted">And 4 earlier</li>
				</ul>
			</div>
			<p class="mt-4 text-sm text-muted">
				Yes counts it as income, never as spending.
			</p>
		</>
	);
}

function BudgetsBody() {
	return (
		<>
			<StepBar done={3} label="Step 4 of 4 · Your budgets" />
			<h1 class="mt-6 font-serif text-4xl font-semibold tracking-tight">
				Keep these budgets?
			</h1>
			<p class="mt-3 text-muted">
				Each is what you spent in August and September, on average, rounded up
				to the next $10.
			</p>
			<ul class="mt-4 border-t border-rule">
				<li class="flex items-center gap-3 border-b border-rule py-2">
					<CategoryIcon icon="groceries" color="cat-blue" />
					<div class="min-w-0 flex-1">
						<p>Groceries</p>
						<p class="text-sm text-muted tabular-nums">Aug $610 · Sep $674</p>
					</div>
					<p class="tabular-nums">$650</p>
				</li>
				<li class="flex items-center gap-3 border-b border-rule py-2">
					<CategoryIcon icon="eating-out" color="cat-plum" />
					<div class="min-w-0 flex-1">
						<p>Eating out</p>
						<p class="text-sm text-muted tabular-nums">Aug $218 · Sep $231</p>
					</div>
					<p class="tabular-nums">$230</p>
				</li>
				<li class="flex items-center gap-3 border-b border-rule py-2">
					<CategoryIcon icon="gas" color="cat-slate" />
					<div class="min-w-0 flex-1">
						<p>Gas</p>
						<p class="text-sm text-muted tabular-nums">Aug $162 · Sep $171</p>
					</div>
					<p class="tabular-nums">$170</p>
				</li>
				<li class="flex items-center gap-3 border-b border-rule py-2">
					<CategoryIcon icon="kids" color="cat-ochre" />
					<div class="min-w-0 flex-1">
						<p>Kids</p>
						<p class="text-sm text-muted tabular-nums">Aug $280 · Sep $296</p>
					</div>
					<p class="tabular-nums">$290</p>
				</li>
				<li class="py-2 text-sm text-muted">And 8 more</li>
			</ul>
			<div class="mt-2 flex justify-between border-t-[3px] border-double border-ink pt-2 font-medium">
				<span>12 budgets</span>
				<span class="tabular-nums">$4,050 a month</span>
			</div>
		</>
	);
}

function DoneBody() {
	return (
		<>
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0 flex-1">
					<StepBar done={4} label="Setup done" />
				</div>
				<Notebook strokes={5} ink size="size-16" />
			</div>
			<h1 class="mt-4 font-serif text-4xl font-semibold tracking-tight">
				You're set up.
			</h1>
			<p class="mt-4 text-lg text-muted">Safe to spend in October</p>
			<p class="font-serif text-6xl font-semibold tracking-tight tabular-nums">
				$1,284
			</p>
			<p class="mt-2 text-muted">
				What's left of October's budgets after what you've spent, the bills
				still to pay and your savings.
			</p>
			<h2 class="mt-6 text-sm text-muted">What you set up</h2>
			<dl class="mt-2 border-t border-rule">
				<div class="flex justify-between gap-3 border-b border-rule py-2">
					<dt>Pay</dt>
					<dd class="text-right tabular-nums">
						ACME Corp · $2,450 every other Friday
					</dd>
				</div>
				<div class="flex justify-between gap-3 border-b border-rule py-2">
					<dt>Bills</dt>
					<dd class="text-right tabular-nums">8 bills · $1,240 a month</dd>
				</div>
				<div class="flex justify-between gap-3 border-b border-rule py-2">
					<dt>Budgets</dt>
					<dd class="text-right tabular-nums">12 budgets · $4,050 a month</dd>
				</div>
				<div class="flex justify-between gap-3 border-b border-rule py-2">
					<dt>Savings</dt>
					<dd class="text-right tabular-nums">$150 a month</dd>
				</div>
			</dl>
		</>
	);
}

function DoneActions() {
	return (
		<>
			<Button type="button" class="w-full">
				Go to Home
			</Button>
			<p class="mt-3 text-center text-sm text-muted">
				From now on Tally sorts new transactions as your bank sends them.
			</p>
		</>
	);
}

// ---------------------------------------------------------------------------------------------
// The proposal: the specimen, with Today, A (recommended) and B.

export function SetupProposal() {
	return (
		<Specimen
			id="p141-setup"
			title="P141 · A new family's setup"
			tier="visual"
			sentence="A new family's setup, drawn for the owner's pick (#770): Today, with setup in Home's top and five strokes; A (recommended), setup on its own pages, a welcome and four steps with a step bar, ending on Safe to spend; and B, setup kept on Home in plain words, four numbered steps and no fifth."
		>
			<Fixed>
				every number comes from the family's own bank, one question at a time,
				budgets kept all in one tap or one at a time, nothing saved until the
				family says yes, and Tally can only read the bank.
			</Fixed>
			<Choices>
				<Choice
					name="Today"
					note="Setup lives in Home's top as five strokes, the fifth being Tally's own first night, and the questions on a page of their own. Safe to spend stays off Home until the fifth stroke, the next day."
					width="w-full"
				>
					<Shot caption="Before a bank">
						<Phone
							label="Today, before a bank"
							demo={false}
							tab="home"
							masthead={<FeedbackButton />}
						>
							<div class="flex items-center justify-between gap-4">
								<h1 class="min-w-0 font-serif text-4xl font-semibold tracking-tight">
									Five strokes, and you're set up.
								</h1>
								<Notebook strokes={0} ink size="size-24" />
							</div>
							<TallySteps steps={TODAY_FIRST} />
							<div class="mt-6">
								<Button type="button" class="w-full">
									Link a bank
								</Button>
								<p class="mt-3 text-sm text-muted">
									Tally can only read your bank. It can't move money.
								</p>
							</div>
						</Phone>
					</Shot>
					<Shot caption="The pay question">
						<Phone
							label="Today, the pay question"
							demo={false}
							masthead={<FeedbackButton />}
						>
							<FirstPage
								right={<SmallNotebook strokes={1} text="1 of 5" />}
								lines={[
									{ text: "From Chase · 412 lines · Jul 16 to Oct 13" },
									{ text: "Moves between your accounts · 6 left out" },
								]}
							>
								<p class="mt-6 text-base text-muted">
									Your bank shows ACME CORP PAYROLL paying $2,450 every other
									Friday, 7 times since Jul 17.
								</p>
								<h2 class="mt-3 font-serif text-2xl font-semibold">
									Is this your pay?
								</h2>
								<div class="mt-4">
									<Button type="button" class="w-full">
										Yes, that's my pay
									</Button>
								</div>
								<div class="mt-1 flex justify-center">
									<Button kind="text" type="button">
										No, it's something else
									</Button>
								</div>
							</FirstPage>
						</Phone>
					</Shot>
					<Shot caption="After the questions">
						<Phone
							label="Today, after the questions"
							demo={false}
							tab="home"
							masthead={<FeedbackButton />}
						>
							<div class="flex justify-end">
								<Notebook strokes={4} ink size="size-24" />
							</div>
							<p class="mt-3 font-serif text-lg italic">
								Four. Tomorrow Tally keeps count on its own, and that's the
								fifth.
							</p>
							<TallySteps steps={TODAY_AFTER} />
						</Phone>
					</Shot>
				</Choice>
				<Choice
					name="A · Setup on its own pages"
					note="A welcome says what Tally does and how long setup takes, then four steps, each one screen with a step bar, one question, the bank's own numbers as a ledger card and the answer at the screen's foot. No tab bar until setup is done. Budgets end with the savings question, as now. The finish shows Safe to spend and what was set up. Tally's first night is no longer a step, and Home is plain Home from the moment setup ends."
					cost="Setup becomes a page of its own, and Home's first-week top, the fifth-day view and How Tally works' Your first week go."
					picked
					why="It says it's setup and how long it takes, uses plain words, and ends with the family's own number."
					width="w-full"
				>
					<Shot caption="Welcome">
						<Phone
							label="A, the welcome"
							demo={false}
							masthead={<FeedbackButton />}
							overlay={
								<Foot>
									<WelcomeActions />
								</Foot>
							}
						>
							<WelcomeBody />
						</Phone>
					</Shot>
					<Shot caption="Reading your bank">
						<Phone
							label="A, reading your bank"
							demo={false}
							masthead={<FeedbackButton />}
							overlay={
								<Foot>
									<Button kind="secondary" type="button" class="w-full">
										Link another bank
									</Button>
									<p class="mt-3 text-center text-sm text-muted">
										Link every bank and card you use, so your questions cover
										them all.
									</p>
								</Foot>
							}
						>
							<ReadingBody />
						</Phone>
					</Shot>
					<Shot caption="Step 2: your pay">
						<Phone
							label="A, the pay question"
							demo={false}
							masthead={<FeedbackButton />}
							overlay={
								<Foot>
									<Button type="button" class="w-full">
										Yes, that's my pay
									</Button>
									<div class="mt-1 flex justify-center">
										<Button kind="text" type="button">
											No, it's something else
										</Button>
									</div>
								</Foot>
							}
						>
							<PayBody />
						</Phone>
					</Shot>
					<Shot caption="Step 4: your budgets">
						<Phone
							label="A, the budgets question"
							demo={false}
							masthead={<FeedbackButton />}
							overlay={
								<Foot>
									<Button type="button" class="w-full">
										Keep all 12
									</Button>
									<div class="mt-1 flex justify-center">
										<Button kind="text" type="button">
											Go one at a time
										</Button>
									</div>
								</Foot>
							}
						>
							<BudgetsBody />
						</Phone>
					</Shot>
					<Shot caption="Done">
						<Phone
							label="A, setup done"
							demo={false}
							masthead={<FeedbackButton />}
							overlay={
								<Foot>
									<DoneActions />
								</Foot>
							}
						>
							<DoneBody />
						</Phone>
					</Shot>
					<Shot caption="Welcome, on desktop">
						<SetupDesk label="A, the welcome">
							<WelcomeBody />
							<div class="mt-6">
								<WelcomeActions />
							</div>
						</SetupDesk>
					</Shot>
					<Shot caption="Done, on desktop">
						<SetupDesk label="A, setup done">
							<DoneBody />
							<div class="mt-6">
								<DoneActions />
							</div>
						</SetupDesk>
					</Shot>
				</Choice>
				<Choice
					name="B · Setup stays on Home, in plain words"
					note="Home's top keeps setup, as four numbered steps in plain words with a check for each done, Link your bank and the questions' band as today. The fifth step goes, and Safe to spend shows on Home the moment the budgets are kept."
					cost="Setup still shares the screen with Home's tabs and Budget, so it reads less like a first visit."
					width="w-full"
				>
					<Shot caption="Before a bank">
						<Phone
							label="B, before a bank"
							demo={false}
							tab="home"
							masthead={<FeedbackButton />}
						>
							<h1 class="mt-2 font-serif text-4xl font-semibold tracking-tight">
								Welcome to Tally.
							</h1>
							<p class="mt-3 text-lg">
								Four steps to your first budget, about four minutes.
							</p>
							<p class="mt-6 text-sm text-muted">Setup · 0 of 4 done</p>
							<SetupSteps
								steps={[
									{
										name: "Link your bank",
										note: "About a minute",
										state: "next",
									},
									{ name: "Your pay", note: "One question", state: "next" },
									{ name: "Your bills", note: "One question", state: "next" },
									{ name: "Your budgets", note: "One tap", state: "next" },
								]}
							/>
							<div class="mt-6">
								<Button type="button" class="w-full">
									Link your bank
								</Button>
								<p class="mt-3 text-sm text-muted">
									Tally can only read your bank. It can't move money.
								</p>
							</div>
						</Phone>
					</Shot>
					<Shot caption="Questions ready">
						<Phone
							label="B, questions ready"
							demo={false}
							tab="home"
							masthead={<FeedbackButton />}
						>
							<p class="mt-2 text-lg">
								Your bank is read: 412 transactions from Chase, all sorted.
							</p>
							<div class="mt-4">
								<Band
									href="/first-page"
									detail="Your pay, your bills and your budgets. About three minutes."
								>
									Answer 3 questions
								</Band>
							</div>
							<p class="mt-6 text-sm text-muted">Setup · 1 of 4 done</p>
							<SetupSteps
								steps={[
									{ name: "Link your bank", note: "Chase", state: "done" },
									{ name: "Your pay", note: "Next", state: "current" },
									{ name: "Your bills", note: "One question", state: "next" },
									{ name: "Your budgets", note: "One tap", state: "next" },
								]}
							/>
						</Phone>
					</Shot>
					<Shot caption="Just finished">
						<Phone
							label="B, just finished"
							demo={false}
							tab="home"
							masthead={<FeedbackButton />}
						>
							<p class="text-lg text-muted">Safe to spend</p>
							<p class="font-serif text-6xl font-semibold tracking-tight tabular-nums">
								$1,284
							</p>
							<p class="mt-4 rounded-control bg-band p-4">
								You're set up. Tally sorts new transactions as your bank sends
								them.
							</p>
							<h2 class="mt-8 font-serif text-3xl font-semibold">Budget</h2>
							<ul class="mt-2 border-t border-rule">
								<li class="flex justify-between border-b border-rule py-3">
									<span>Groceries</span>
									<span class="tabular-nums text-muted">$412 of $650</span>
								</li>
								<li class="flex justify-between border-b border-rule py-3">
									<span>Eating out</span>
									<span class="tabular-nums text-muted">$96 of $230</span>
								</li>
								<li class="flex justify-between border-b border-rule py-3">
									<span>Gas</span>
									<span class="tabular-nums text-muted">$88 of $170</span>
								</li>
							</ul>
						</Phone>
					</Shot>
				</Choice>
			</Choices>
		</Specimen>
	);
}

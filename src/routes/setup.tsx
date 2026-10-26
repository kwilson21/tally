import { type Context, Hono } from "hono";
import { addressOf } from "../address";
import { householdToday } from "../dates";
import { bankSyncs } from "../db/accounts";
import { readFinish, settleAndLoad } from "../first-tally/first-page";
import { readSetup, type SetupView } from "../first-tally/setup";
import {
	bankState,
	readYourBanks,
	type YourBank,
} from "../first-tally/your-banks";
import { hxTrigger } from "../htmx";
import { vapidKeys } from "../push/keys";
import { loadsPlaid } from "../security";
import { flaggedBanks, homeBankNotice } from "../stale-bank";
import { HomeSeenCheckIn } from "../views/home-seen";
import { Layout } from "../views/layout";
import { LinkBank, plaidScripts } from "../views/link-bank";
import {
	EmailLine,
	readingNextLine,
	readingStatus,
	readingStep,
	SetupReading,
	SortBar,
} from "../views/setup-reading";
import { SetupWelcome, WELCOME_HEADING } from "../views/setup-welcome";
import { YourBanks } from "../views/your-banks";
import {
	drawQuestionScreen,
	finishPage,
	questionHeading,
	questionsPage,
} from "./first-page";
import { enabled } from "./plaid";

// Setup (P142 A, decision 148, spec §8.8): a new family's first screens: the welcome before a bank, Reading your bank after
// one, and the questions once they open (one screen each, routes/first-page.tsx). Home sends a new family here until setup
// is done (the budgets stroke drawn); then /setup draws the finish, with the month's numbers, and Home is plain Home. The
// setup screen's refresh and check-in draw and move it in place (redrawSetup), so nothing reloads the page.

type App = { Bindings: Env };
export const setupRoute = new Hono<App>();

/** "3,5" as the ids of the banks a page already shows as in: positive whole numbers, anything else ignored. */
const idsIn = (raw: string | undefined) =>
	new Set(
		(raw ?? "")
			.split(",")
			.filter((part) => /^[1-9]\d*$/.test(part))
			.map(Number),
	);

/** "Chase is in: 412 transactions.", the sentence a bank that came in is announced with. */
const inSentence = (bank: YourBank) =>
	`${bank.name} is in: ${bank.count.toLocaleString("en-US")} ${bank.count === 1 ? "transaction" : "transactions"}.`;

/** The reading steps the Your banks poll names, so a change of step is announced once (decision 146). */
const READING_STEPS = ["reading", "sorting", "slow", "run"] as const;

/**
 * Setup as the Your banks poll and the presence check-in read it: today, the banks, the flagged ones, and the setup (null when
 * none is drawn). Each bank's flag is matched to it by id, as setupView does.
 */
export async function readHomeSetup(db: D1Database) {
	const today = await householdToday(db);
	const banks = await readYourBanks(db);
	const flagged = flaggedBanks(
		banks.map((bank) => ({
			id: bank.id,
			name: bank.name,
			needsAttention: bank.status === "needs_attention",
			lastSyncedAt: bank.lastSyncedAt,
		})),
		today,
	);
	const setup = await readSetup(db, { today, flagged });
	return { today, banks, flagged, setup };
}

/**
 * The Plaid button for setup's screens: the same button GET /setup draws (its label, kind, refresh and target), so a redraw
 * (redrawSetup) draws it the same way. A redraw lands on a /setup page that was loaded in full, which brought Plaid's script
 * and CSP when Plaid is on, and plaid-link.js listens on the document, so a redrawn button works.
 */
function welcomeLink(env: Env) {
	return enabled(env) ? (
		<LinkBank
			class="w-full"
			label="Link your bank"
			refresh="/setup"
			target="#setup-screen"
		/>
	) : undefined;
}
function anotherBankLink(env: Env) {
	return enabled(env) ? (
		<LinkBank
			class="w-full"
			label="Link another bank"
			kind="secondary"
			refresh="/setup"
			target="#setup-screen"
		/>
	) : undefined;
}

/**
 * The setup screen moved on in place (decision 146): a phase that left the reading screen is answered here, with no reload.
 * The questions open: the first question is drawn into #setup-screen in place, announced with the words of the question
 * (`said` first, then "Your questions are ready." and the question's heading), and its heading takes the focus. Set up
 * (the budgets stroke drawn): the page is sent to /setup, which draws the finish. Otherwise the screen is redrawn into
 * #setup-screen, with the words it draws announced (`said` first) and its heading or status taking focus, since the control
 * that had it has gone.
 */
export async function redrawSetup(
	c: Context<App>,
	read: Awaited<ReturnType<typeof readHomeSetup>>,
	said = "",
) {
	const { today, banks, flagged, setup } = read;
	if (setup?.phase === "ready") {
		const model = await settleAndLoad(c.env.DB, today);
		const heading = questionHeading(model);
		const message = [said, "Your questions are ready.", heading ?? ""]
			.filter(Boolean)
			.join(" ");
		c.header("HX-Retarget", "#setup-screen");
		c.header("HX-Reswap", "outerHTML");
		c.header(
			"HX-Trigger",
			hxTrigger({ toast: { message, type: "info" }, announce: message }),
		);
		return c.html(drawQuestionScreen(model, { focus: true }));
	}
	if (!setup) {
		c.header("HX-Redirect", "/setup");
		return c.body(null, 204);
	}
	c.header("HX-Retarget", "#setup-screen");
	c.header("HX-Reswap", "outerHTML");
	if (setup.phase === "before") {
		const message = [said, WELCOME_HEADING].filter(Boolean).join(" ");
		c.header(
			"HX-Trigger",
			hxTrigger({ toast: { message, type: "info" }, announce: message }),
		);
		return c.html(<SetupWelcome linkBank={welcomeLink(c.env)} focusHeading />);
	}
	const message = [said, readingStatus(setup)].filter(Boolean).join(" ");
	c.header(
		"HX-Trigger",
		hxTrigger({ toast: { message, type: "info" }, announce: message }),
	);
	const pushKeys = await vapidKeys(c.env);
	return c.html(
		<SetupReading
			view={setup}
			bankLine={homeBankNotice(flagged, today)?.words}
			yourBanks={{ banks, today, keepPolling: setup.refreshes }}
			notify={pushKeys ? { vapidKey: pushKeys.publicKey } : undefined}
			linkBank={anotherBankLink(c.env)}
			focusStatus
		/>,
	);
}

/**
 * The setup's full page: the welcome before a bank, Reading your bank after one, and the questions once they are open (one
 * screen each; `?budgets=one` asks the budgets one category at a time, with its question focused). The family app only. The
 * demo has no setup and answers 404. Once setup is done (the budgets stroke drawn, decision 148), the setup finish is drawn at
 * 200 for a reload or a later visit, from the record and this month's numbers (readFinish, with focus false).
 */
setupRoute.get("/setup", async (c) => {
	if (c.env.DEMO === "true") return c.notFound();
	const today = await householdToday(c.env.DB);
	const flagged = flaggedBanks(await bankSyncs(c.env.DB), today);
	const view = await readSetup(c.env.DB, { today, flagged });
	if (!view) {
		// Setup is done (readSetup is null only once the budgets stroke is drawn, which never goes back), so the finish is
		// read from the record. The redirect is a guard for a record that has no budgets stroke after all.
		const finish = await readFinish(c.env.DB, today);
		return finish ? c.html(finishPage(finish, false)) : c.redirect("/", 303);
	}
	if (view.phase === "ready") {
		const oneAtATime = c.req.query("budgets") === "one";
		const model = await settleAndLoad(c.env.DB, today, { oneAtATime });
		return c.html(questionsPage(model, oneAtATime));
	}
	const pushKeys = await vapidKeys(c.env);
	const plaidButton = enabled(c.env) && loadsPlaid(c);
	const plaid = plaidScripts(plaidButton);
	const modules = pushKeys ? [...plaid.modules, "/js/push.js"] : plaid.modules;
	if (view.phase === "before")
		return c.html(
			<Layout
				setup
				title="Setup · Tally"
				demo={false}
				currentPath={addressOf(c)}
				{...plaid}
				modules={modules}
			>
				<SetupWelcome linkBank={plaidButton ? welcomeLink(c.env) : undefined} />
			</Layout>,
		);
	const banks = await readYourBanks(c.env.DB);
	const pushNotify = pushKeys ? { vapidKey: pushKeys.publicKey } : undefined;
	return c.html(
		<Layout
			setup
			title="Setup · Tally"
			demo={false}
			currentPath={addressOf(c)}
			{...plaid}
			modules={modules}
		>
			<SetupReading
				view={view}
				bankLine={homeBankNotice(flagged, today)?.words}
				yourBanks={{ banks, today, keepPolling: view.refreshes }}
				notify={pushNotify}
				linkBank={plaidButton ? anotherBankLink(c.env) : undefined}
			/>
		</Layout>,
	);
});

/**
 * The reading screen's status, bar, next line and email line, swapped out of band by a refresh (the Your banks poll and the presence
 * check-in's answer both draw them this way), so the focused status is replaced only by these swaps, never by the poll's own.
 */
export function ReadingSwaps({
	view,
	bankLine,
}: {
	view: SetupView;
	bankLine: boolean;
}) {
	const step = readingStep(view);
	return (
		<>
			<p id="setup-status" hx-swap-oob="innerHTML">
				{readingStatus(view)}
			</p>
			<div id="setup-progress" hx-swap-oob="innerHTML">
				{(step === "sorting" || step === "slow") && (
					<SortBar sorted={view.sorted} total={view.total} />
				)}
			</div>
			<p id="setup-next" hx-swap-oob="innerHTML">
				{readingNextLine(view, bankLine)}
			</p>
			<div id="setup-email" hx-swap-oob="innerHTML">
				<EmailLine emailed={view.emailed} />
			</div>
		</>
	);
}

/**
 * The Your banks list's refresh (P140 A, decision 133, spec §8.8). The list polls it every 5 seconds while a bank is being read
 * or Tally sorts within the hour, and the run's wait holds nothing to poll for (decision 150). It answers with the list, and the
 * status, the bar and the next line out of band (so the focused status is never replaced). A bank that came in since the page was
 * drawn is announced once. A step change (reading, sorting, taking longer than usual, the daily run's wait) is announced once,
 * with its status, and the presence check-in is swapped to the new step (decision 146). A phase that left reading is answered by
 * redrawSetup. The demo draws no setup, so it answers 204.
 */
setupRoute.get("/setup/banks", async (c) => {
	if (c.env.DEMO === "true") return c.body(null, 204);
	const read = await readHomeSetup(c.env.DB);
	const { today, banks, flagged, setup } = read;
	const shown = idsIn(c.req.query("in"));
	const arrived = banks
		.filter((bank) => bankState(bank, today) === "in" && !shown.has(bank.id))
		.map(inSentence);
	const said = arrived.join(" ");
	if (setup?.phase !== "reading") return redrawSetup(c, read, said);
	// A step change is announced once, with its status: the poll names the step the page shows (decision 146). A count that ticks
	// on within the step is never announced alone.
	const shownStep = READING_STEPS.find((step) => step === c.req.query("step"));
	const stepNow = readingStep(setup);
	const stepChanged = shownStep !== undefined && shownStep !== stepNow;
	const message = [said, stepChanged ? readingStatus(setup) : ""]
		.filter(Boolean)
		.join(" ");
	if (message)
		c.header(
			"HX-Trigger",
			hxTrigger({ toast: { message, type: "info" }, announce: message }),
		);
	return c.html(
		<>
			<YourBanks
				banks={banks}
				today={today}
				keepPolling={setup.refreshes}
				step={stepNow}
			/>
			<ReadingSwaps
				view={setup}
				bankLine={Boolean(homeBankNotice(flagged, today))}
			/>
			{/* The check-in is swapped to the step this poll found, so the page keeps checking in with the step it shows. */}
			{stepChanged && <HomeSeenCheckIn step={stepNow} oob />}
		</>,
	);
});

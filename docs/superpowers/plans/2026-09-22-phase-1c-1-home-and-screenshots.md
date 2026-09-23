# Phase 1c-1 (Home and Screenshots) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two pull requests, in this order:
1. **Part A (#39):** CI takes a screenshot of every page at desktop and phone size and puts them in the PR description. It also fails if a page logs a console error.
2. **Part B (#9):** the real Home screen. It shows Safe to spend as the headline, the status sentence, the "N transactions need a category" band, and a spent-of-budget bar per category, all computed from the seeded demo data.

Part A goes first, so Part B's PR is the first one whose screenshots appear automatically.

**Architecture:**
- **Part A:** a separate `Screenshots` workflow (not the required `check`) starts the app with `wrangler dev`, seeds it through the local scheduled-handler endpoint, and runs `scripts/screenshots.mjs` (Playwright) over a list of pages. It commits the PNGs to an orphan `screenshots` branch under `pr-<N>/<sha7>/`, then replaces a marked section of the PR description with an image table. `scripts/pr-body.mjs` holds the page list and the pure "replace the section" function, and both are unit-tested.
- **Part B:** `GET /` loads the month with `loadMonth`, summarizes it with `summarizeMonth` (both from 1b), and renders new view components:
  - `CategoryIcon`
  - `ProgressRow`, with its bar drawn as inline SVG because the CSP forbids inline `style` attributes
  - `Band`
  - `LedgerIllustration`

  The bar's geometry is a pure, tested function.

**Tech stack:** Hono JSX, Tailwind v4 tokens (already in `src/styles/app.css`), and D1 through `src/db/month.ts`. Part A adds `playwright` as a dev dependency (decision 24, written in Task A0). It also uses GitHub Actions, `wrangler dev`, and the GitHub REST API over plain `fetch`.

**Spec:** §6 (budget math), §8 (Home screen), §11 (Testing). **Direction:** `docs/design-concepts/README.md`, round 4, "Home, mobile" and round 3, "Home, desktop" (Illustrated ledger). **Issues:** #39 (Part A) and #9 (Part B). One issue per PR, per `CLAUDE.md`.

**Out of scope here, with where each part goes:**
- "Due soon" bills and the "after N bills due this week" line: Phase 3 (#25, #26). Until then `unpaidDueBillsCents` is 0.
- The "Things to try" block, the "How this works" link, and the How it works page: #13.
- The Transactions list and its uncategorized filter: #10. Home links to `/transactions?uncategorized=1`, and #10 must honor that query parameter.

**Checked on 2026-09-23.** The Cloudflare and Playwright doc sites were blocked by this environment's network policy, so each item was checked against the installed or published package instead:
- **`wrangler dev` 4.136.3:** `GET /cdn-cgi/handler/scheduled` runs the `scheduled` handler with no extra flag. Tested locally: it returned `200 ok` and seeded 125 transactions. `/__scheduled` returns 404 without `--test-scheduled`, so don't use it.
- **`playwright` 1.63.0** (latest on npm):
  - `browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" })`
  - `page.screenshot({ path, fullPage: true, animations: "disabled" })`
  - `page.on("console")` and `page.on("pageerror")` for error collection
  - `npx playwright install --with-deps chromium` installs the browser in CI
- **Lucide icons:** `lucide-static` 1.47.0 gives `chevron-right` as `m9 18 6-6-6-6`. `circle-dashed` has eight arcs, copied verbatim into Task B2.
- **CSP:** `style-src 'self'` (src/security.ts) blocks `style="…"` attributes. SVG presentation attributes (`width="58.9%"` on a `<rect>`) are not CSS and are allowed, so the bars are SVG.
- **GitHub REST:** `GET` and `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` with a `body` field, and the headers `Authorization: Bearer`, `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`. The executor re-checks these on docs.github.com before writing Task A3.

---

## Owner review: choices this plan makes

1. **The headline doesn't count up.** DESIGN.md's Motion pattern says "the headline counts up," but that needs JavaScript. `CLAUDE.md` allows custom JS only for Plaid Link and the toast listener. The bars still fill with a CSS animation, and Task B5 changes the Motion line to "Bars fill. `prefers-reduced-motion` shows the final state."
2. **The Uncategorized row is shown in the Budget list.** Spec §6 says it's "shown as their own row and never hidden." The study doesn't draw it, so it goes last in the list, with a dashed-circle icon and no bar.
3. **The headline rounds to whole dollars.** For example, $282.99 shows as $283. This is the existing `formatCents(…, { wholeDollars: true })` behavior, documented as "headline amounts."
4. **Screenshots live on an orphan `screenshots` branch in this repo.** Decision 24 covers it. The branch only grows. Pruning it goes on the spec's Later list.
5. **The screenshot job runs only for PRs from this repo, not forks.** It needs write access to push the images and edit the description.

---

## File structure

| File | Part | Job |
|---|---|---|
| `scripts/pr-body.mjs` | A | `PAGES` (what gets screenshotted), `VIEWPORTS`, and `withScreenshots(body, section)` (pure) |
| `scripts/screenshots.mjs` | A | Opens each page at each viewport in Chromium, saves PNGs, and fails on console errors |
| `scripts/update-pr-body.mjs` | A | Builds the image table and writes it into the PR description over plain `fetch` |
| `.github/workflows/screenshots.yml` | A | Runs the three steps above on every same-repo PR |
| `test/pr-body.test.ts` | A | Tests `withScreenshots`, and checks that `PAGES` covers every nav destination |
| `test/tsconfig.json` | A | `allowJs`, so tests can import the `.mjs` helpers |
| `src/dates.ts` | B | `todayUtc()` and `monthName(month)` |
| `src/views/bar.ts` | B | `barGeometry(spentCents, budgetCents)` (pure) |
| `src/views/category.tsx` | B | `CategoryIcon` and the token → Tailwind class map |
| `src/views/progress-row.tsx` | B | `ProgressRow`: icon, name, "$412 of $700", SVG bar, over-budget marker |
| `src/views/band.tsx` | B | `Band`: the one tinted row that links to the thing to do |
| `src/views/illustration.tsx` | B | `LedgerIllustration`: notebook, tally marks, terracotta pencil (SVG) |
| `src/views/icons.tsx` | B | Adds `chevron-right` and `circle-dashed` |
| `src/routes/home.tsx` | B | The Home screen |
| `src/routes/destinations.tsx`, `src/index.tsx` | B | Read `DEMO` from env instead of `demo={true}`; use `todayUtc()` |
| `src/styles/app.css` | B | Bar-fill animation with a reduced-motion override |
| `test/dates.test.ts`, `test/bar.test.ts`, `test/home.test.ts` | B | Tests |

---

# Part A: screenshots in every PR (#39)

### Task A0: Branch, spec, decision

- [ ] **Step 1: Branch.** Run: `git switch main && git pull && git switch -c phase-1c-1-screenshots`

- [ ] **Step 2: Spec §11 → Testing.** Add after the E2E bullet:
  `- **Screenshots:** on every pull request from this repo, CI screenshots each page at 1280×800 and 390×844, puts them in the PR description, and fails if a page logs a console error.`
  Add to §12, Later list: `- Pruning old PR screenshots from the screenshots branch`

- [ ] **Step 3: Add decision 24** to `docs/decisions.md`:
  `| 24 | 2026-09-23 | CI screenshots every page with Playwright (dev dependency) and stores the images on an orphan \`screenshots\` branch, linked from the PR description | Owner request (#39). The spec already names Playwright for E2E. A branch in this public repo needs no extra service or secret, and the owner reviews UI without running the app. |`

- [ ] **Step 4: Update `CLAUDE.md` → Pull requests.** Change the UI PRs line to:
  `- UI PRs: CI adds screenshots (1280×800 and 390×844) to the description; check them before asking for review. The owner merges after looking. Non-UI PRs may auto-merge.`

- [ ] **Step 5: Commit.**
```bash
git add docs/superpowers/specs/2026-09-22-tally-design.md docs/decisions.md CLAUDE.md
git commit -m "docs: add CI screenshots to spec, decisions, and PR rules"
```

### Task A1: Page list and PR-body section (pure, tested first)

- [ ] **Step 1: Let tests import `.mjs`.** In `test/tsconfig.json`, add `"allowJs": true` to `compilerOptions` and `"../scripts/**/*.mjs"` to `include`.

- [ ] **Step 2: Write the failing test** `test/pr-body.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { PAGES, withScreenshots } from "../scripts/pr-body.mjs";
import { SIDEBAR_ITEMS } from "../src/views/nav";

const SECTION =
	"<!-- screenshots:start -->\n## Screenshots\nnew\n<!-- screenshots:end -->";

describe("withScreenshots", () => {
	it("appends the section to a description without one", () => {
		expect(withScreenshots("Closes #9.", SECTION)).toBe(
			`Closes #9.\n\n${SECTION}`,
		);
	});

	it("handles an empty description", () => {
		expect(withScreenshots(null, SECTION)).toBe(SECTION);
		expect(withScreenshots("", SECTION)).toBe(SECTION);
	});

	it("replaces only the marked section, keeping text before and after", () => {
		const body =
			"Intro\n\n<!-- screenshots:start -->\nold\n<!-- screenshots:end -->\n\nOutro";
		expect(withScreenshots(body, SECTION)).toBe(
			`Intro\n\n${SECTION}\n\nOutro`,
		);
	});
});

describe("PAGES", () => {
	it("covers every navigation destination plus More", () => {
		const paths = PAGES.map((p) => p.path);
		for (const item of SIDEBAR_ITEMS) expect(paths).toContain(item.href);
		expect(paths).toContain("/more");
	});
});
```
  Run: `npm test -- pr-body`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `scripts/pr-body.mjs`:
```js
// What CI screenshots, and how the images go into a PR description. Pure; used by the scripts next to it.

/** Every page in the app. test/pr-body.test.ts fails if a nav destination is missing. */
export const PAGES = [
	{ name: "home", path: "/" },
	{ name: "transactions", path: "/transactions" },
	{ name: "bills", path: "/bills" },
	{ name: "trends", path: "/trends" },
	{ name: "accounts", path: "/accounts" },
	{ name: "documents", path: "/documents" },
	{ name: "settings", path: "/settings" },
	{ name: "more", path: "/more" },
];

export const VIEWPORTS = [
	{ name: "desktop", width: 1280, height: 800 },
	{ name: "phone", width: 390, height: 844 },
];

const START = "<!-- screenshots:start -->";
const END = "<!-- screenshots:end -->";

/** Puts the screenshot section into a PR description, replacing an earlier one if present. */
export function withScreenshots(body, section) {
	const text = body ?? "";
	const start = text.indexOf(START);
	const end = text.indexOf(END);
	if (start !== -1 && end > start) {
		return text.slice(0, start) + section + text.slice(end + END.length);
	}
	return text ? `${text}\n\n${section}` : section;
}
```
  Run: `npm test -- pr-body && npm run typecheck`. Expected: PASS.

- [ ] **Step 4: Commit.** `git add scripts test && git commit -m "feat: add screenshot page list and PR description section"`

### Task A2: Take the screenshots

- [ ] **Step 1: Add the dependency.** Run: `npm install --save-dev playwright@^1.63.0`. Locally the browser is at `/opt/pw-browsers` in cloud sessions (`PLAYWRIGHT_BROWSERS_PATH` is set). Elsewhere, run `npx playwright install chromium` once.

- [ ] **Step 2: Write** `scripts/screenshots.mjs`:
```js
// Opens every page at desktop and phone size, saves a full-page PNG of each,
// and exits non-zero if any page logs a console error (spec §11 finish line: no console errors).
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { PAGES, VIEWPORTS } from "./pr-body.mjs";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:8787";
const OUT = "screenshots";

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
const errors = [];

for (const viewport of VIEWPORTS) {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		reducedMotion: "reduce",
	});
	for (const page of PAGES) {
		const tab = await context.newPage();
		tab.on("console", (m) => {
			if (m.type() === "error") errors.push(`${page.path} (${viewport.name}): ${m.text()}`);
		});
		tab.on("pageerror", (e) => errors.push(`${page.path} (${viewport.name}): ${e.message}`));
		const response = await tab.goto(BASE + page.path, { waitUntil: "networkidle" });
		if (!response?.ok()) errors.push(`${page.path} (${viewport.name}): HTTP ${response?.status()}`);
		await tab.screenshot({
			path: `${OUT}/${page.name}-${viewport.name}.png`,
			fullPage: true,
			animations: "disabled",
		});
		await tab.close();
	}
	await context.close();
}

await browser.close();
if (errors.length > 0) {
	console.error(`Console errors:\n${errors.join("\n")}`);
	process.exit(1);
}
console.log(`Saved ${PAGES.length * VIEWPORTS.length} screenshots to ${OUT}/`);
```
  The error text includes only the page path and the browser message. The demo has no real data, so nothing sensitive is logged.

- [ ] **Step 3: Add scripts and ignore output.** In `package.json` scripts: `"screenshots": "node scripts/screenshots.mjs"`. In `.gitignore`: `screenshots/`.

- [ ] **Step 4: Check locally.** Run `npm run db:migrate:local`, start `npm run dev`, run `npm run db:seed:local`, then `npm run screenshots`. Expected: "Saved 16 screenshots", no console errors. Open two PNGs (home desktop and phone) and check they look like the shell.

- [ ] **Step 5: Commit.** `git add package.json package-lock.json .gitignore scripts && git commit -m "feat: screenshot every page at desktop and phone size"`

### Task A3: Put them in the PR description

- [ ] **Step 1: Write** `scripts/update-pr-body.mjs`:
```js
// Writes the screenshot table into the PR description. Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, DIR, SHA.
import { PAGES, VIEWPORTS, withScreenshots } from "./pr-body.mjs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, DIR, SHA } = process.env;
const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`;
const headers = {
	Authorization: `Bearer ${GITHUB_TOKEN}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
};
const raw = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/screenshots/${DIR}`;
const img = (page, viewport, width) =>
	`<img src="${raw}/${page.name}-${viewport.name}.png" width="${width}" alt="${page.name}, ${viewport.name}">`;

const [desktop, phone] = VIEWPORTS;
const rows = PAGES.map(
	(p) => `| \`${p.path}\` | ${img(p, desktop, 480)} | ${img(p, phone, 180)} |`,
);
const section = [
	"<!-- screenshots:start -->",
	"## Screenshots",
	`_Taken by CI at ${SHA.slice(0, 7)} on the seeded demo data. Desktop ${desktop.width}×${desktop.height}, phone ${phone.width}×${phone.height}._`,
	"",
	"| Page | Desktop | Phone |",
	"|---|---|---|",
	...rows,
	"<!-- screenshots:end -->",
].join("\n");

const current = await fetch(api, { headers });
if (!current.ok) throw new Error(`GET PR failed: ${current.status}`);
const { body } = await current.json();

const updated = await fetch(api, {
	method: "PATCH",
	headers,
	body: JSON.stringify({ body: withScreenshots(body, section) }),
});
if (!updated.ok) throw new Error(`PATCH PR failed: ${updated.status}`);
console.log("PR description updated.");
```

- [ ] **Step 2: Write** `.github/workflows/screenshots.yml`:
```yaml
name: Screenshots

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: screenshots-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  screenshots:
    # Forks get a read-only token and can't push images or edit the description.
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    env:
      WRANGLER_SEND_METRICS: "false"
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run db:migrate:local
      - name: Start the app and seed the demo
        run: |
          npx wrangler dev --port 8787 > wrangler.log 2>&1 &
          for i in $(seq 1 60); do curl -fsS http://127.0.0.1:8787/healthz && break; sleep 2; done
          npm run db:seed:local
      - run: npm run screenshots
      - name: Publish images to the screenshots branch
        id: publish
        env:
          PR: ${{ github.event.pull_request.number }}
          SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          dir="pr-${PR}/${SHA::7}"
          git config --global user.name "github-actions[bot]"
          git config --global user.email "41898282+github-actions[bot]@users.noreply.github.com"
          if git fetch --depth=1 origin screenshots; then
            git worktree add --detach shots FETCH_HEAD
          else
            git worktree add --detach shots
            git -C shots switch --orphan screenshots
          fi
          mkdir -p "shots/$dir"
          cp screenshots/*.png "shots/$dir/"
          git -C shots add .
          git -C shots commit -m "chore: screenshots for #${PR} at ${SHA::7}"
          # Each run writes its own folder, so a rebase after a race never conflicts.
          for i in 1 2 3; do
            git -C shots push origin HEAD:screenshots && break
            git -C shots fetch origin screenshots && git -C shots rebase FETCH_HEAD
          done
          echo "dir=$dir" >> "$GITHUB_OUTPUT"
      - name: Update the PR description
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          DIR: ${{ steps.publish.outputs.dir }}
          SHA: ${{ github.event.pull_request.head.sha }}
        run: node scripts/update-pr-body.mjs
      - if: failure()
        run: tail -50 wrangler.log || true
```
  Before committing, re-check the current `actions/checkout` and `actions/setup-node` majors against `ci.yml` (both `@v7` today), and check that `git worktree add --detach` followed by `switch --orphan` is still valid in the runner's git.

- [ ] **Step 3: Lint and commit.** Run `npm run lint && npm run typecheck && npm test`. Then: `git add scripts .github && git commit -m "ci: add screenshots to every PR description"`

- [ ] **Step 4: Push and open the PR.**
```bash
git push -u origin phase-1c-1-screenshots
gh pr create -R kwilson21/tally --title "ci: screenshots in every PR description" --body "Closes #39.
Plan: docs/superpowers/plans/2026-09-22-phase-1c-1-home-and-screenshots.md (Part A)"
```
  The PR checks itself. Within a few minutes the `Screenshots` job should add a table of 8 pages × 2 sizes to this PR's description, showing the 1a shell. If it fails, fix it on this branch. The run is its own acceptance test.

---

# Part B: the Home screen (#9)

Start after Part A is merged: `git switch main && git pull && git switch -c phase-1c-1-home`.

**What Home shows, from the seed** (1b's designed totals; `test/seed.test.ts` already asserts them):

| Element | Seed value | Rendered |
|---|---|---|
| Month title | current month | "September" |
| Safe to spend | 28299 | "$283" |
| Status sentence | Eating Out 28600 of 25000 | "Eating Out is $36 over. Everything else is on track." |
| Band | 12 uncategorized | "12 transactions need a category" → `/transactions?uncategorized=1` |
| Groceries | 41200 of 70000 | "$412 of $700", green bar |
| Eating Out | 28600 of 25000 | "$286 of $250", brick bar, alert icon + "over budget" |
| Gas / Kids / Household | 18600 of 20000 / 21000 of 30000 / 9500 of 25000 | green bars |
| Uncategorized | 22801 | "$228", dashed icon, no bar |

### Task B1: Dates and bar geometry (pure, tested first)

- [ ] **Step 1: Failing tests.** `test/dates.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { monthName, todayUtc } from "../src/dates";

describe("monthName", () => {
	it.each([
		["2026-09", "September"],
		["2027-01", "January"],
		["2026-12", "December"],
	])("%s is %s", (month, name) => expect(monthName(month)).toBe(name));
});

describe("todayUtc", () => {
	it("is a YYYY-MM-DD string", () => {
		expect(todayUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
```
  `test/bar.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { barGeometry } from "../src/views/bar";

describe("barGeometry", () => {
	it("fills by spent over budget, with the limit at the end", () => {
		expect(barGeometry(41200, 70000)).toEqual({ fillPct: 58.9, limitPct: 100 });
	});

	it("when over, fills the whole track and moves the limit notch back", () => {
		expect(barGeometry(28600, 25000)).toEqual({ fillPct: 100, limitPct: 87.4 });
	});

	it("shows an empty bar when refunds make spent negative", () => {
		expect(barGeometry(-500, 10000)).toEqual({ fillPct: 0, limitPct: 100 });
	});

	it("handles a zero budget without dividing by zero", () => {
		expect(barGeometry(0, 0)).toEqual({ fillPct: 0, limitPct: 0 });
		expect(barGeometry(500, 0)).toEqual({ fillPct: 100, limitPct: 0 });
	});
});
```
  Run: `npm test -- dates bar`. Expected: FAIL.

- [ ] **Step 2: Implement** `src/dates.ts`:
```ts
// Dates stay as YYYY-MM-DD / YYYY-MM strings (spec §6). No time-zone math.

const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

/** Today's UTC date. The demo seed and nightly reset use the same day. */
export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

/** "2026-09" → "September". */
export function monthName(month: string): string {
	return MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
}
```
  `src/views/bar.ts`:
```ts
/**
 * Where a budget bar's fill ends and where its limit notch sits, as percentages of the track.
 * The track spans the larger of budget and spent, so an over-budget bar is full and its notch
 * shows how far past the limit it went.
 */
export function barGeometry(spentCents: number, budgetCents: number) {
	const spent = Math.max(spentCents, 0);
	const scale = Math.max(budgetCents, spent, 1);
	const pct = (n: number) => Math.round((n / scale) * 1000) / 10;
	return { fillPct: pct(spent), limitPct: pct(Math.max(budgetCents, 0)) };
}
```
  (Biome will reformat the `MONTHS` array; that's fine.) Run tests. Expected: PASS.

- [ ] **Step 3: Use `todayUtc()` in the scheduled handler** (`src/index.tsx`): replace `new Date().toISOString().slice(0, 10)` with `todayUtc()` and keep the comment. Run `npm test`.

- [ ] **Step 4: Commit.** `git add src test && git commit -m "feat: add month names, today's date, and budget bar geometry"`

### Task B2: Icons and view components

- [ ] **Step 1: Add icons** to `PATHS` in `src/views/icons.tsx` (from `lucide-static` 1.47.0, ISC):
```tsx
	"chevron-right": <path d="m9 18 6-6-6-6" />,
	"circle-dashed": (
		<>
			<path d="M10.1 2.182a10 10 0 0 1 3.8 0" />
			<path d="M13.9 21.818a10 10 0 0 1-3.8 0" />
			<path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
			<path d="M2.182 13.9a10 10 0 0 1 0-3.8" />
			<path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" />
			<path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
			<path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" />
			<path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />
		</>
	),
```
  `test/icons.test.ts` already covers every name in `ICON_NAMES`.

- [ ] **Step 2: `src/views/category.tsx`.** A category's icon, drawn in its color token:
```tsx
import { ICON_NAMES, Icon, type IconName } from "./icons";

// Literal class names so Tailwind generates them. Keys are the color tokens stored on categories.
const COLOR_CLASS: Record<string, string> = {
	"cat-blue": "text-cat-blue",
	"cat-plum": "text-cat-plum",
	"cat-slate": "text-cat-slate",
	"cat-ochre": "text-cat-ochre",
	"cat-brown": "text-cat-brown",
};

function iconName(icon: string): IconName {
	return (ICON_NAMES as string[]).includes(icon) ? (icon as IconName) : "list";
}

export function CategoryIcon({ icon, color }: { icon: string; color: string }) {
	return (
		<span class={COLOR_CLASS[color] ?? "text-muted"}>
			<Icon name={iconName(icon)} class="size-7" />
		</span>
	);
}
```

- [ ] **Step 3: `src/views/progress-row.tsx`.** One budget row:
```tsx
import { formatCents } from "../money";
import { barGeometry } from "./bar";
import { CategoryIcon } from "./category";
import { Icon } from "./icons";

type Props = {
	name: string;
	icon: string;
	color: string;
	spentCents: number;
	budgetCents: number;
};

const whole = (cents: number) =>
	formatCents(cents, { wholeDollars: true });

// Bar is inline SVG: the CSP forbids style attributes, and SVG width attributes aren't CSS.
export function ProgressRow({ name, icon, color, spentCents, budgetCents }: Props) {
	const over = spentCents > budgetCents;
	const { fillPct, limitPct } = barGeometry(spentCents, budgetCents);
	return (
		<li class="flex items-start gap-4 py-3">
			<CategoryIcon icon={icon} color={color} />
			<div class="min-w-0 flex-1">
				<div class="flex items-baseline justify-between gap-3">
					<span class="text-lg">{name}</span>
					<span class="text-lg">
						{whole(spentCents)} of {whole(budgetCents)}
					</span>
				</div>
				<svg class="mt-2 h-2 w-full" aria-hidden="true">
					<rect width="100%" height="100%" rx="4" class="fill-rule" />
					<rect
						width={`${fillPct}%`}
						height="100%"
						rx="4"
						class={`bar-fill ${over ? "fill-over" : "fill-ok"}`}
					/>
					<line
						x1={`${limitPct}%`}
						x2={`${limitPct}%`}
						y1="0"
						y2="100%"
						class="stroke-ink"
						stroke-width="2"
					/>
				</svg>
				{over && (
					<p class="mt-1 flex items-center justify-end gap-1 text-over">
						<Icon name="alert" class="size-5" />
						over budget
					</p>
				)}
			</div>
		</li>
	);
}
```
  Status is never color alone: the "$286 of $250" text and the "over budget" word carry the meaning, and the SVG is decorative.

- [ ] **Step 4: `src/views/band.tsx`.** The one row that matters:
```tsx
import type { Child } from "hono/jsx";
import { Icon } from "./icons";

export function Band({ href, children }: { href: string; children?: Child }) {
	return (
		<a
			href={href}
			class="flex min-h-11 items-center justify-between gap-3 bg-band px-4 py-3 text-lg text-ink no-underline"
		>
			<span>{children}</span>
			<Icon name="chevron-right" />
		</a>
	);
}
```

- [ ] **Step 5: `src/views/illustration.tsx`.** Draw `LedgerIllustration` as one `<svg viewBox="0 0 120 120" aria-hidden="true">`:
  - a spiral notebook tilted a few degrees, with ink strokes and the 1.75 stroke rules scaled up
  - a tally-mark group on the page, reusing the four-plus-one geometry from `TallyMark`
  - a pencil in `stroke-accent`
  - `fill="none"`, round caps and joins

  Compare it against the round 4 study (`home-mobile-illustrated-ledger-v1.webp`). It's a composition reference, not something to trace. Keep it under ~40 lines of JSX. Size: `class="size-28 lg:size-36 shrink-0"`.

- [ ] **Step 6: Run `npm run build && npm run typecheck && npm run lint && npm test`, then commit.**
  `git add src && git commit -m "feat: add category icon, progress row, band, and ledger illustration"`

### Task B3: The Home route (route test first)

- [ ] **Step 1: Replace `test/home.test.ts`** with:
```ts
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { todayUtc } from "../src/dates";
import { resetDemo } from "../src/demo/reset";

async function home() {
	const res = await exports.default.fetch("http://tally.test/");
	return { res, html: await res.text() };
}

describe("GET / with the demo seed", () => {
	beforeEach(async () => {
		await resetDemo(env.DB, todayUtc());
	});

	it("renders an HTML page titled Tally", async () => {
		const { res, html } = await home();
		expect(res.status).toBe(200);
		expect(html).toContain("<title>Tally</title>");
	});

	it("leads with safe to spend and the status sentence", async () => {
		const { html } = await home();
		expect(html).toContain("Safe to spend");
		expect(html).toContain("$283");
		expect(html).toContain(
			"Eating Out is $36 over. Everything else is on track.",
		);
	});

	it("links the uncategorized count to the filtered list", async () => {
		const { html } = await home();
		expect(html).toContain('href="/transactions?uncategorized=1"');
		expect(html).toContain("12 transactions need a category");
	});

	it("shows spent of budget per category, and marks over budget with a word", async () => {
		const { html } = await home();
		expect(html).toContain("$412 of $700");
		expect(html).toContain("$286 of $250");
		expect(html.match(/over budget/g)?.length).toBe(1);
		expect(html).toContain("Uncategorized");
		expect(html).toContain("$228");
	});
});

describe("GET / with no data", () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare("DELETE FROM transactions"),
			env.DB.prepare("DELETE FROM budget_amounts"),
		]);
	});

	it("says no budgets are set and hides the band", async () => {
		const { res, html } = await home();
		expect(res.status).toBe(200);
		expect(html).toContain("No budgets set yet.");
		expect(html).not.toContain("need a category");
		expect(html).toContain("$0");
	});
});
```
  Run: `npm test -- home`. Expected: FAIL on the new assertions.

- [ ] **Step 2: Implement** `src/routes/home.tsx`:
```tsx
import { Hono } from "hono";
import { statusSentence, summarizeMonth } from "../budget";
import { monthName, todayUtc } from "../dates";
import { loadMonth } from "../db/month";
import { formatCents } from "../money";
import { Band } from "../views/band";
import { Icon } from "../views/icons";
import { LedgerIllustration } from "../views/illustration";
import { Layout } from "../views/layout";
import { ProgressRow } from "../views/progress-row";

export const home = new Hono<{ Bindings: Env }>();

// Home: what's safe to spend this month, and how each category is doing (spec §8, feature 1).
home.get("/", async (c) => {
	const month = todayUtc().slice(0, 7);
	const data = await loadMonth(c.env.DB, month);
	// Bills arrive in Phase 3; until then nothing is set aside for them.
	const summary = summarizeMonth({ month, ...data, unpaidDueBillsCents: 0 });
	const looks = new Map(data.categories.map((cat) => [cat.id, cat]));
	const { count, spentCents } = summary.uncategorized;

	return c.html(
		<Layout active="home" demo={c.env.DEMO === "true"}>
			<h1 class="font-serif text-5xl font-semibold tracking-tight">
				{monthName(month)}
			</h1>
			<div class="mt-4 flex items-center justify-between gap-6 lg:justify-start">
				<div>
					<p class="text-lg text-muted">Safe to spend</p>
					<p class="font-serif text-6xl font-semibold tracking-tight lg:text-7xl">
						{formatCents(summary.safeToSpendCents, { wholeDollars: true })}
					</p>
				</div>
				<LedgerIllustration />
			</div>
			<p class="mt-3 font-serif text-lg italic">
				{statusSentence(summary.categories)}
			</p>

			{count > 0 && (
				<div class="mt-6">
					<Band href="/transactions?uncategorized=1">
						{count} {count === 1 ? "transaction needs" : "transactions need"} a
						category
					</Band>
				</div>
			)}

			<section class="mt-8" aria-labelledby="budget-title">
				<h2 id="budget-title" class="font-serif text-3xl font-semibold">
					Budget
				</h2>
				{summary.categories.length === 0 && count === 0 ? (
					<p class="mt-2 text-muted">No budgets yet.</p>
				) : (
					<ul class="mt-2 divide-y divide-rule">
						{summary.categories.map((cat) => (
							<ProgressRow
								name={cat.name}
								icon={looks.get(cat.id)?.icon ?? "list"}
								color={looks.get(cat.id)?.color ?? ""}
								spentCents={cat.spentCents}
								budgetCents={cat.budgetCents}
							/>
						))}
						{count > 0 && (
							<li class="flex items-center gap-4 py-3 text-muted">
								<Icon name="circle-dashed" class="size-7" />
								<span class="flex-1 text-lg">Uncategorized</span>
								<span class="text-lg">
									{formatCents(spentCents, { wholeDollars: true })}
								</span>
							</li>
						)}
					</ul>
				)}
			</section>
		</Layout>,
	);
});
```
  The Budget list's width stays readable on desktop: wrap the section in `lg:max-w-2xl`, leaving room for "Due soon" beside it in Phase 3, as in the desktop study.

- [ ] **Step 3: Read `DEMO` from env in `src/routes/destinations.tsx`** too (both `demo={true}` → `demo={c.env.DEMO === "true"}`).

- [ ] **Step 4: Run all checks.** `npm run build && npm run typecheck && npm run lint && npm test`. Expected: all pass, including the existing `layout.test.ts` and `nav-routes.test.ts`.

- [ ] **Step 5: Commit.** `git add src test && git commit -m "feat: build the Home screen from the month summary"`

### Task B4: Motion

- [ ] **Step 1: Add to `src/styles/app.css`** (after `@layer base`):
```css
/* Budget bars grow from the left on load. Reduced motion shows the final state. */
@keyframes bar-fill {
	from {
		transform: scaleX(0);
	}
}
.bar-fill {
	transform-box: fill-box;
	transform-origin: left;
	animation: bar-fill 600ms ease-out both;
}
@media (prefers-reduced-motion: reduce) {
	.bar-fill {
		animation: none;
	}
}
```

- [ ] **Step 2: Build and commit.** `npm run build && npm run lint`, then `git commit -am "feat: animate budget bars, respecting reduced motion"`

### Task B5: Design system docs, local check, PR

- [ ] **Step 1: `DESIGN.md`:**
  - Components table: replace the "Planned (Phase 1c)" row's `ProgressRow` and `Band` with real rows, and add rows for `CategoryIcon` and `LedgerIllustration`:
    - `| CategoryIcon | A category's line icon, drawn in its color token. |`
    - `| ProgressRow | One category: icon, name, "spent of budget," and an SVG bar with a notch at the limit; over budget adds an alert icon and the words "over budget." |`
    - `| Band | The one tinted row per screen that links to the thing to do next. |`
    - `| LedgerIllustration | The notebook-and-pencil line drawing beside the headline; ink plus a terracotta pencil. |`
    - The Planned row keeps `TransactionRow, CategoryChip, BottomSheet, FormField` (built in 1c-2).
  - Patterns → Motion: `- Motion: budget bars fill on load (CSS). prefers-reduced-motion shows the final state. No count-up: it would need custom JavaScript.`
  - Patterns: `- Bars are inline SVG. The CSP forbids style attributes, and SVG width attributes aren't CSS.`

- [ ] **Step 2: Check in a browser.** Run `npm run db:migrate:local`, `npm run dev`, `npm run db:seed:local`, then `npm run screenshots`. Compare `screenshots/home-desktop.png` and `home-phone.png` with the round 4 studies. The layout should match, allowing for the omitted Things to try and Due soon parts. Check that the console is clean (the script fails otherwise). Tab through the page and check the focus ring on the band link. Add a line to `docs/design-concepts/README.md` → Build checks.

- [ ] **Step 3: Commit, push, PR.**
```bash
git add DESIGN.md docs/design-concepts/README.md
git commit -m "docs: record Home components and motion in the design system"
git push -u origin phase-1c-1-home
gh pr create -R kwilson21/tally --title "feat: Home screen" --body "Closes #9.
Plan: docs/superpowers/plans/2026-09-22-phase-1c-1-home-and-screenshots.md (Part B)
Bills (Due soon) arrive in Phase 3; Things to try and How this works arrive with #13."
```
  Screenshots are added to the description by CI (Part A). This is a UI PR, so the owner merges it after looking.

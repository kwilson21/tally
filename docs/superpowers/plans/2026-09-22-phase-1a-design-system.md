# Phase 1a (Design System Foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Tally's design system foundations: `DESIGN.md`, color, type, and space tokens, self-hosted fonts, icons and the tally-mark brand, the app shell (sidebar and bottom tabs, demo banner, toast), and security headers. Phase 1c screens then only compose these.

**Architecture:** Tailwind v4 compiles `src/styles/app.css`, where the tokens live in `@theme`, into `public/assets/app.css`. HTMX 4 and fonts are served from `public/` (our own origin, so the CSP stays `'self'`). Icons are inline SVG JSX components copied from Lucide (ISC license), plus the hand-built tally mark. The shell is a Hono JSX layout used by every page.

**Tech stack:** Tailwind CSS v4 (`tailwindcss`, `@tailwindcss/cli`), `htmx.org@4`, Hono JSX, `hono/secure-headers`, Fontsource-hosted Inter and Newsreader woff2 files (OFL), Lucide icon paths (ISC).

**Spec:** `docs/superpowers/specs/2026-09-22-tally-design.md` §8 and §10. **Direction:** `docs/design-concepts/README.md` (Quiet ledger + Illustrated ledger, rounds 1–4). **Issue:** kwilson21/tally#4 "Wireframes…" is replaced by the studies; this plan's work is tracked on a new issue created in Task 0.

**Docs checked on 2026-09-22 (Context7):**
- Tailwind v4: install `tailwindcss @tailwindcss/cli`; build with `npx @tailwindcss/cli -i <in> -o <out>`; the CSS begins with `@import "tailwindcss";`; tokens go in `@theme { --color-*: …; --font-*: …; }`, which generates utilities like `bg-paper` and `font-serif`.
- htmx 4.0.0 (released 2026-08-28): `npm install htmx.org`; the file is at `dist/htmx.min.js`. The `HX-Trigger` response header with JSON (`{"toast": {...}}`) dispatches events on the requesting element after the swap. `HX-Trigger-After-Swap`/`-After-Settle` were removed; use `HX-Trigger`.
- Hono `secureHeaders` from `hono/secure-headers`: `xFrameOptions: 'DENY'`, and `contentSecurityPolicy` with `defaultSrc`, `scriptSrc`, `styleSrc`, `fontSrc`, `imgSrc`, `objectSrc`, `frameAncestors`, `baseUri`, and `formAction` arrays.

**Token contrast (computed 2026-09-22 against paper `#FBF8F2` and band `#EFEBE3`, WCAG 2.x):**

| Token | Hex | On paper | On band | Allowed use |
|---|---|---|---|---|
| ink | `#0E0E0E` | 18.21 | 16.24 | all text |
| muted | `#4A4A4A` | 8.36 | 7.45 | secondary text |
| accent (terracotta) | `#AE5534` | 4.78 | 4.26 | links and the selected nav item **on paper only** (below 4.5 on band) |
| ok (green) | `#2F7A4F` | 4.93 | 4.40 | on-track bar fill; not text on band |
| over (brick) | `#A93226` | 6.25 | 5.57 | over-budget/overdue bar, icon, and word |
| cat-blue (Groceries) | `#3F6C9A` | 5.18 | 4.62 | category icon |
| cat-plum (Eating Out) | `#7A4A7E` | 6.37 | 5.68 | category icon |
| cat-slate (Gas) | `#4F6272` | 5.96 | 5.32 | category icon |
| cat-ochre (Kids) | `#A87414` | 3.83 | 3.41 | category icon only (≥3:1 for graphics; never text) |
| cat-brown (Household) | `#7A5230` | 6.44 | 5.74 | category icon |
| rule / track | `#E8E3DA` | 1.21 | — | dividers and the empty bar track (decorative) |

---

## File structure

| File | Job |
|---|---|
| `DESIGN.md` | The design system for humans and AI sessions: principles, tokens, type roles, components, patterns, rules |
| `src/styles/app.css` | Tailwind entry: `@import "tailwindcss"`, `@font-face`, `@theme` tokens, a few base rules |
| `public/fonts/*.woff2`, `public/fonts/LICENSE-*.txt` | Self-hosted Inter and Newsreader, plus their OFL licenses |
| `public/assets/app.css` | Build output (git-ignored) |
| `public/vendor/htmx.min.js` | Copied from `node_modules` at build (git-ignored) |
| `public/js/toast.js` | Toast + screen-reader announce listener (the only custom JS besides Plaid Link) |
| `src/views/icons.tsx` | `Icon` component and the icon path map (Lucide, ISC) |
| `src/views/brand.tsx` | `TallyMark` glyph and `Wordmark` |
| `src/views/nav.tsx` | `NAV_ITEMS`, `Sidebar` (desktop), `BottomTabs` (mobile) |
| `src/views/layout.tsx` | Document shell: head, skip link, demo banner, sidebar/tabs, main, live regions |
| `src/security.ts` | `secureHeaders` configuration |
| `src/index.tsx` | Adds the security middleware |
| `test/layout.test.ts`, `test/security.test.ts`, `test/icons.test.ts` | Route and component tests |

---

### Task 0: Tracking issue

- [ ] **Step 1: Create the issue and close the wireframes issue as superseded**

```bash
gh issue create -R kwilson21/tally --milestone "Phase 1: Core demo live" --title "Design system foundations (DESIGN.md, tokens, fonts, icons, shell)" --body "Plan: docs/superpowers/plans/2026-09-22-phase-1a-design-system.md. Direction: docs/design-concepts/README.md. Decisions 20-21."
gh issue close 4 -R kwilson21/tally -c "Superseded by generated studies (docs/design-concepts, rounds 1-4, owner-selected) per decision 21."
```

Write down the new issue number as `DS_ISSUE`, for the PR body later.

- [ ] **Step 2: Branch**

```bash
git switch -c phase-1a-design-system
```

---

### Task 1: Tailwind and HTMX build pipeline

**Files:**
- Modify: `package.json`, `.gitignore`
- Create: `src/styles/app.css` (minimal for now)

- [ ] **Step 1: Install**

```bash
npm install -D tailwindcss @tailwindcss/cli
npm install htmx.org@4
```

Expected: installs without errors. If `htmx.org@4` doesn't resolve, run `npm view htmx.org versions --json | tail -5`, pick the newest `4.x`, and report it.

- [ ] **Step 2: Add scripts to `package.json`.** Merge these into the existing `scripts` object, keeping the current ones except `dev` and `deploy`, which are replaced:

```json
{
  "build:css": "tailwindcss -i ./src/styles/app.css -o ./public/assets/app.css --minify",
  "build:vendor": "mkdir -p public/vendor && cp node_modules/htmx.org/dist/htmx.min.js public/vendor/htmx.min.js",
  "build": "npm run build:vendor && npm run build:css",
  "dev": "npm run build && wrangler dev",
  "deploy": "npm run build && wrangler deploy"
}
```

- [ ] **Step 3: Ignore build output.** Append to `.gitignore`:

```gitignore
public/assets/
public/vendor/
```

- [ ] **Step 4: Create a minimal `src/styles/app.css`**

```css
@import "tailwindcss";
@source "../";
```

- [ ] **Step 5: Build and verify**

Run: `npm run build && ls -la public/assets/app.css public/vendor/htmx.min.js`
Expected: both files exist, and `app.css` is non-empty.

- [ ] **Step 6: CI builds assets too.** In `.github/workflows/ci.yml`, add `- run: npm run build` after `npm ci`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore src/styles/app.css .github/workflows/ci.yml
git commit -m "build: add Tailwind v4 CSS build and vendored htmx 4

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Self-hosted fonts

**Files:**
- Create: `public/fonts/inter-latin-wght-normal.woff2`, `public/fonts/newsreader-latin-wght-normal.woff2`, `public/fonts/newsreader-latin-wght-italic.woff2`, `public/fonts/LICENSE-Inter.txt`, `public/fonts/LICENSE-Newsreader.txt`

- [ ] **Step 1: Find the exact file URLs.** Open Fontsource's pages for Inter and Newsreader (https://fontsource.org/fonts/inter, https://fontsource.org/fonts/newsreader) and use the CDN URLs they list for the **variable, latin, weight axis** files (normal, plus italic for Newsreader). Confirm each font is under the SIL Open Font License on its page.

- [ ] **Step 2: Download** the three woff2 files and both license texts into `public/fonts/` with the file names above (`curl -fL -o <file> <url>`). Check each file with `file public/fonts/*.woff2`, which should report "Web Open Font Format (Version 2)".

- [ ] **Step 3: Commit**

```bash
git add public/fonts
git commit -m "feat: self-host Inter and Newsreader variable fonts (OFL)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Tokens

**Files:**
- Modify: `src/styles/app.css`

- [ ] **Step 1: Replace `src/styles/app.css` with:**

```css
@import "tailwindcss";
@source "../";

@font-face {
  font-family: "Inter";
  src: url("/fonts/inter-latin-wght-normal.woff2") format("woff2");
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Newsreader";
  src: url("/fonts/newsreader-latin-wght-normal.woff2") format("woff2");
  font-weight: 200 800;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Newsreader";
  src: url("/fonts/newsreader-latin-wght-italic.woff2") format("woff2");
  font-weight: 200 800;
  font-style: italic;
  font-display: swap;
}

/* Tokens. Contrast table and allowed uses: DESIGN.md. */
@theme {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-serif: "Newsreader", Georgia, serif;

  --color-paper: #fbf8f2;
  --color-band: #efebe3;
  --color-ink: #0e0e0e;
  --color-muted: #4a4a4a;
  --color-rule: #e8e3da;
  --color-accent: #ae5534;

  --color-ok: #2f7a4f;
  --color-over: #a93226;

  --color-cat-blue: #3f6c9a;
  --color-cat-plum: #7a4a7e;
  --color-cat-slate: #4f6272;
  --color-cat-ochre: #a87414;
  --color-cat-brown: #7a5230;

  --radius-control: 0.75rem;
  --radius-sheet: 1.25rem;
}

@layer base {
  html {
    background: var(--color-paper);
    color: var(--color-ink);
    font-family: var(--font-sans);
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  a {
    color: var(--color-accent);
  }
  :focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
}
```

- [ ] **Step 2: Build and check that the utilities exist**

Run: `npm run build:css && grep -c -- "--color-cat-ochre" public/assets/app.css`
Expected: `1` or more.

- [ ] **Step 3: Commit**

```bash
git add src/styles/app.css
git commit -m "feat: add design tokens (colors, fonts, radii) in Tailwind @theme

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Icons and brand

**Files:**
- Create: `src/views/icons.tsx`, `src/views/brand.tsx`, `test/icons.test.ts`

- [ ] **Step 1: Write the failing test** `test/icons.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { TallyMark } from "../src/views/brand";
import { ICON_NAMES, Icon } from "../src/views/icons";

describe("Icon", () => {
  it.each(ICON_NAMES)("renders %s as decorative inline SVG", async (name) => {
    const html = await Icon({ name }).toString();
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('stroke="currentColor"');
  });
});

describe("TallyMark", () => {
  it("draws four strokes and one diagonal", async () => {
    const html = await TallyMark({}).toString();
    expect(html.match(/<line/g)?.length).toBe(5);
    expect(html).toContain('aria-hidden="true"');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/icons.test.ts`. Expected: FAIL, because the modules don't exist yet.

- [ ] **Step 3: Get the Lucide paths.** Run `npm pack lucide-static --pack-destination /tmp && tar -xzf /tmp/lucide-static-*.tgz -C /tmp`. For each Lucide name below, open `/tmp/package/icons/<lucide-name>.svg` and copy the child elements (`<path>`, `<circle>`, `<rect>`, `<line>`, `<polyline>`) as JSX. Don't add `lucide-static` to `package.json`. Tally icon → Lucide name:

`home`→`house`, `list`→`list`, `bills`→`file-text`, `trends`→`chart-column`, `more`→`ellipsis`, `accounts`→`credit-card`, `documents`→`folder`, `settings`→`settings`, `groceries`→`shopping-basket`, `eating-out`→`utensils`, `gas`→`fuel`, `kids`→`star`, `household`→`house`, `income`→`arrow-down`, `transfer`→`arrow-left-right`, `alert`→`triangle-alert`, `chevron`→`chevron-right`, `close`→`x`, `search`→`search`.

- [ ] **Step 4: Create `src/views/icons.tsx`.** The shape is fixed; fill in `PATHS` with the JSX children copied in Step 3, one entry per name.

```tsx
import type { Child } from "hono/jsx";

// Paths from Lucide (https://lucide.dev), ISC License. Copied, not a dependency.
const PATHS = {
  home: <>{/* children of house.svg */}</>,
  list: <>{/* list.svg */}</>,
  bills: <>{/* file-text.svg */}</>,
  trends: <>{/* chart-column.svg */}</>,
  more: <>{/* ellipsis.svg */}</>,
  accounts: <>{/* credit-card.svg */}</>,
  documents: <>{/* folder.svg */}</>,
  settings: <>{/* settings.svg */}</>,
  groceries: <>{/* shopping-basket.svg */}</>,
  "eating-out": <>{/* utensils.svg */}</>,
  gas: <>{/* fuel.svg */}</>,
  kids: <>{/* star.svg */}</>,
  household: <>{/* house.svg */}</>,
  income: <>{/* arrow-down.svg */}</>,
  transfer: <>{/* arrow-left-right.svg */}</>,
  alert: <>{/* triangle-alert.svg */}</>,
  chevron: <>{/* chevron-right.svg */}</>,
  close: <>{/* x.svg */}</>,
  search: <>{/* search.svg */}</>,
} satisfies Record<string, Child>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];

type IconProps = { name: IconName; class?: string };

export function Icon({ name, class: className = "size-6" }: IconProps) {
  return (
    <svg
      class={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
```

Replace every `{/* … */}` with the real elements. No comment placeholders may remain (`grep -c "\.svg \*/" src/views/icons.tsx` must print `0`).

- [ ] **Step 5: Create `src/views/brand.tsx`**

```tsx
type MarkProps = { class?: string };

// Four upright strokes crossed by one diagonal: "卌", Tally's brand mark.
export function TallyMark({ class: className = "size-7" }: MarkProps) {
  return (
    <svg
      class={className}
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      stroke-width="2.25"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <line x1="6" y1="5" x2="6" y2="23" />
      <line x1="11" y1="5" x2="11" y2="23" />
      <line x1="16" y1="5" x2="16" y2="23" />
      <line x1="21" y1="5" x2="21" y2="23" />
      <line x1="2" y1="19" x2="26" y2="9" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <a href="/" class="flex items-center gap-2 text-ink no-underline" aria-label="Tally home">
      <TallyMark />
      <span class="font-serif text-3xl font-semibold tracking-tight">Tally</span>
    </a>
  );
}
```

- [ ] **Step 6: Run the tests.** Run: `npm test -- test/icons.test.ts`. Expected: PASS (19 icon cases plus 1 mark case).

- [ ] **Step 7: Commit**

```bash
git add src/views/icons.tsx src/views/brand.tsx test/icons.test.ts
git commit -m "feat: add Lucide-based icon set and tally-mark brand

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Security headers

**Files:**
- Create: `src/security.ts`, `test/security.test.ts`
- Modify: `src/index.tsx`

- [ ] **Step 1: Write the failing test** `test/security.test.ts`

```ts
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("security headers", () => {
  it("denies framing and restricts scripts to our origin", async () => {
    const res = await exports.default.fetch("http://tally.test/");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/security.test.ts`. Expected: FAIL, since the headers are missing.

- [ ] **Step 3: Create `src/security.ts`**

```ts
import { secureHeaders } from "hono/secure-headers";

// Everything is served from our own origin; Plaid's CDN is added on the Accounts page in Phase 2.
export const security = secureHeaders({
  xFrameOptions: "DENY",
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    fontSrc: ["'self'"],
    imgSrc: ["'self'", "data:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
  },
});
```

- [ ] **Step 4: Register it first** in `src/index.tsx`, right after `const app = new Hono<{ Bindings: Env }>();`:

```tsx
import { security } from "./security";
// …
app.use("*", security);
```

- [ ] **Step 5: Run all tests.** Run: `npm test`. Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/security.ts src/index.tsx test/security.test.ts
git commit -m "feat: add CSP and frame-denial security headers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: App shell (layout, nav, demo banner, live regions)

**Files:**
- Create: `src/views/nav.tsx`, `test/layout.test.ts`
- Modify: `src/views/layout.tsx`, `src/routes/home.tsx`, `test/home.test.ts`

The layout takes `active` (which nav item is current) and `demo` (whether to show the banner). In Phase 1d, `demo` comes from an environment variable. For now, the home route passes `demo: true`.

- [ ] **Step 1: Write the failing test** `test/layout.test.ts`

```ts
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

async function home() {
  const res = await exports.default.fetch("http://tally.test/");
  return res.text();
}

describe("app shell", () => {
  it("loads our CSS and htmx from our own origin", async () => {
    const html = await home();
    expect(html).toContain('href="/assets/app.css"');
    expect(html).toContain('src="/vendor/htmx.min.js"');
    expect(html).toContain('src="/js/toast.js"');
  });

  it("shows the demo banner", async () => {
    expect(await home()).toContain("Demo data. Nothing here is real.");
  });

  it("has a skip link, labeled navs, and marks Home as current", async () => {
    const html = await home();
    expect(html).toContain('href="#main"');
    expect(html).toContain('aria-label="Main"');
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>[\s\S]*?Home/);
  });

  it("has a polite live region and a toast container for HTMX feedback", async () => {
    const html = await home();
    expect(html).toContain('id="announcer"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('id="toasts"');
  });
});
```

- [ ] **Step 2: Run it and watch it fail.** Run: `npm test -- test/layout.test.ts`. Expected: FAIL.

- [ ] **Step 3: Create `src/views/nav.tsx`**

```tsx
import { Icon, type IconName } from "./icons";

export type NavKey =
  | "home"
  | "transactions"
  | "bills"
  | "trends"
  | "accounts"
  | "documents"
  | "settings"
  | "more";

type NavItem = { key: NavKey; label: string; href: string; icon: IconName };

// Desktop sidebar shows every destination; phone tabs show four plus "More".
export const SIDEBAR_ITEMS: NavItem[] = [
  { key: "home", label: "Home", href: "/", icon: "home" },
  { key: "transactions", label: "Transactions", href: "/transactions", icon: "list" },
  { key: "bills", label: "Bills", href: "/bills", icon: "bills" },
  { key: "trends", label: "Trends", href: "/trends", icon: "trends" },
  { key: "accounts", label: "Accounts", href: "/accounts", icon: "accounts" },
  { key: "documents", label: "Documents", href: "/documents", icon: "documents" },
  { key: "settings", label: "Settings", href: "/settings", icon: "settings" },
];

const TAB_ITEMS: NavItem[] = [
  ...SIDEBAR_ITEMS.slice(0, 4),
  { key: "more", label: "More", href: "/more", icon: "more" },
];

const MORE_KEYS: NavKey[] = ["accounts", "documents", "settings", "more"];

function isCurrent(item: NavItem, active?: NavKey) {
  if (item.key === "more") return active !== undefined && MORE_KEYS.includes(active);
  return item.key === active;
}

export function Sidebar({ active }: { active?: NavKey }) {
  return (
    <nav aria-label="Main" class="hidden lg:block">
      <ul class="flex flex-col gap-1">
        {SIDEBAR_ITEMS.map((item) => (
          <li>
            <a
              href={item.href}
              aria-current={isCurrent(item, active) ? "page" : undefined}
              class="flex min-h-11 items-center gap-3 rounded-control px-2 text-lg text-ink no-underline aria-[current=page]:text-accent"
            >
              <Icon name={item.icon} />
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function BottomTabs({ active }: { active?: NavKey }) {
  return (
    <nav
      aria-label="Tabs"
      class="fixed inset-x-0 bottom-0 border-t border-rule bg-paper lg:hidden"
    >
      <ul class="grid grid-cols-5">
        {TAB_ITEMS.map((item) => (
          <li>
            <a
              href={item.href}
              aria-current={isCurrent(item, active) ? "page" : undefined}
              class="flex min-h-14 flex-col items-center justify-center gap-1 text-xs text-muted no-underline aria-[current=page]:text-accent"
            >
              <Icon name={item.icon} />
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 4: Replace `src/views/layout.tsx`**

```tsx
import type { Child } from "hono/jsx";
import { Wordmark } from "./brand";
import { BottomTabs, type NavKey, Sidebar } from "./nav";

type LayoutProps = {
  title?: string;
  active?: NavKey;
  demo: boolean;
  children?: Child;
};

export function Layout({ title = "Tally", active, demo, children }: LayoutProps) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
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
        <div id="toasts" class="fixed inset-x-4 bottom-20 flex flex-col items-center gap-2 lg:bottom-6" />
        <div id="announcer" class="sr-only" aria-live="polite" aria-atomic="true" />
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Update `src/routes/home.tsx`** so it uses the shell:

```tsx
import { Hono } from "hono";
import { Layout } from "../views/layout";

export const home = new Hono<{ Bindings: Env }>();

home.get("/", (c) =>
  c.html(
    <Layout active="home" demo={true}>
      <h1 class="font-serif text-5xl font-semibold tracking-tight">September</h1>
      <p class="mt-2 text-muted">The Home screen is built in Phase 1c.</p>
    </Layout>,
  ),
);
```

- [ ] **Step 6: Update `test/home.test.ts`.** Keep the status, content-type, and `<html lang="en">` assertions. Replace the `<title>Tally</title>` assertion with the same check (the title is unchanged), and don't assert on the placeholder paragraph.

- [ ] **Step 7: Run all tests.** Run: `npm test`. Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/views/nav.tsx src/views/layout.tsx src/routes/home.tsx test/layout.test.ts test/home.test.ts
git commit -m "feat: add app shell with sidebar, bottom tabs, demo banner, and live regions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Toast and announce listener

**Files:**
- Create: `public/js/toast.js`

The server sends `HX-Trigger: {"toast": {"message": "...", "type": "success"}, "announce": "..."}`. htmx 4 dispatches `toast` and `announce` events on the requesting element, and they bubble up to `document.body`.

- [ ] **Step 1: Create `public/js/toast.js`**

```js
// Shows HX-Trigger "toast" messages and speaks "announce" messages to screen readers.
// Text only (textContent), never HTML.
(() => {
  const DISPLAY_MS = 4000;

  document.body.addEventListener("toast", (event) => {
    const { message, type = "success" } = event.detail ?? {};
    if (!message) return;
    const toast = document.createElement("p");
    toast.className =
      "rounded-control border border-rule bg-paper px-4 py-3 text-sm text-ink shadow-sm";
    toast.setAttribute("role", type === "error" ? "alert" : "status");
    toast.textContent = message;
    document.getElementById("toasts")?.append(toast);
    setTimeout(() => toast.remove(), DISPLAY_MS);
  });

  document.body.addEventListener("announce", (event) => {
    const region = document.getElementById("announcer");
    const message = typeof event.detail === "string" ? event.detail : event.detail?.value;
    if (!region || !message) return;
    region.textContent = "";
    requestAnimationFrame(() => {
      region.textContent = message;
    });
  });
})();
```

- [ ] **Step 2: Check the event detail shape against the htmx 4 docs.** Find out what `event.detail` holds when `HX-Trigger` carries a JSON value: the object itself, or `{ value: ... }` for strings. Change the two `event.detail` reads to match, and note the docs link in the commit message. The browser check in Task 9 tests this for real.

- [ ] **Step 3: Commit**

```bash
git add public/js/toast.js
git commit -m "feat: add toast and screen-reader announce listener for HX-Trigger

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: DESIGN.md

**Files:**
- Create: `DESIGN.md`
- Modify: `CLAUDE.md` (one line)

- [ ] **Step 1: Create `DESIGN.md`**

```markdown
# Tally design system

Direction: "Illustrated ledger" (docs/design-concepts/README.md). Calm, warm, glanceable in under 3 seconds. A well-kept paper ledger with a little personality.

## Principles
1. One thing matters per screen. It gets the serif, the size, or the band. Nothing else competes.
2. Status is never color alone. Every red or green state also has an icon and a word.
3. Categories and status never share a hue. Status: green/brick. Categories: blue, plum, slate, ochre, brown.
4. Terracotta means "you can click this." Links and the current nav item only.
5. Explainable in one sentence. If a component can't be, it doesn't exist.

## Tokens (src/styles/app.css @theme)
| Token | Hex | Use | Contrast on paper |
|---|---|---|---|
| paper | #FBF8F2 | page background | — |
| band | #EFEBE3 | the one highlighted row; demo banner | — |
| ink | #0E0E0E | text | 18.2 |
| muted | #4A4A4A | secondary text | 8.4 |
| rule | #E8E3DA | dividers, empty bar track | decorative |
| accent | #AE5534 | links, current nav (never on band: 4.26) | 4.8 |
| ok | #2F7A4F | on-track bar | 4.9 |
| over | #A93226 | over budget / overdue bar, icon, word | 6.3 |
| cat-blue / plum / slate / ochre / brown | #3F6C9A / #7A4A7E / #4F6272 / #A87414 / #7A5230 | category icons only | 5.2 / 6.4 / 6.0 / 3.8 / 6.4 |

Radii: `rounded-control` (0.75rem) for inputs, chips, buttons; `rounded-sheet` (1.25rem) for the bottom sheet top corners. No shadows except toasts.

## Type roles
| Role | Style |
|---|---|
| Page title / month | font-serif, 5xl, semibold, tight tracking |
| Section title | font-serif, 3xl, semibold |
| Headline amount | font-serif, 6xl–7xl, semibold, tabular |
| Status sentence | font-serif italic, lg |
| Body / rows | font-sans (Inter), base–lg, tabular numerals |
| Secondary | font-sans, text-muted |

## Components (src/views/)
| Component | One sentence |
|---|---|
| Wordmark, TallyMark | The tally-mark glyph plus serif "Tally"; the brand. |
| Icon | Lucide line icons, 1.75 stroke, currentColor, always aria-hidden. |
| Sidebar / BottomTabs | The same destinations: a sidebar on desktop, four tabs plus More on phones. |
| Layout | Every page's shell: banner, navigation, main, toast and announce regions. |
| Planned (Phase 1c): ProgressRow, TransactionRow, CategoryChip, BottomSheet, FormField, Band | Built when the first screen needs them. |

## Patterns
- Feedback after an HTMX change: `HX-Trigger: {"toast": {"message", "type"}, "announce": "..."}`.
- Illustrations: SVG, drawn with the icon stroke rules, ink plus one accent. Generated images never ship.
- Motion: bars fill and the headline counts up. `prefers-reduced-motion` shows the final state.

## Governance
- A visual change starts as a generated study, gets owner selection, and is recorded in docs/design-concepts/README.md.
- A new token or component updates this file in the same PR, with its contrast value if it's a color.
- Accessibility: 44px targets, focus-visible ring, labeled forms, aria-live on swap regions.
```

- [ ] **Step 2: Point `CLAUDE.md` at it.** Under `## Source of truth`, add the line: `- Design system: DESIGN.md. UI must use its tokens and components; update it in the same PR when adding either.`

- [ ] **Step 3: Commit**

```bash
git add DESIGN.md CLAUDE.md
git commit -m "docs: add DESIGN.md design system reference

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Browser verification

- [ ] **Step 1: Run the app.** Run: `npm run dev`, then open `http://localhost:8787/`.

- [ ] **Step 2: Screenshot at 1280×800 and 390×844.** Check that the fonts load as Inter and Newsreader (no fallback serif), the banner shows, the sidebar is visible on desktop and the tabs on mobile, Home is terracotta, and the tally mark looks like `卌`.

- [ ] **Step 3: Console check.** Expected: no errors and **no CSP violations**. If htmx 4 injects an inline `<style>` and CSP blocks it, look up htmx 4's config for disabling injected indicator styles, set it with a `<meta name="htmx-config">` tag, and add the indicator CSS to `app.css` instead. Report what you changed.

- [ ] **Step 4: Toast check.** In the browser console, run `document.body.dispatchEvent(new CustomEvent("toast", {detail: {message: "Saved", type: "success"}}))`. A toast should appear and disappear, with no errors.

- [ ] **Step 5: Save the screenshots** to `docs/design-concepts/2026-09-22/build-shell-{desktop,mobile}.png` and note them in the README under a "Build checks" heading.

- [ ] **Step 6: Run all checks.** Run: `npm run build && npm run typecheck && npm run lint && npm test`. Expected: all pass.

- [ ] **Step 7: Commit, push, open a PR**

```bash
git add docs/design-concepts
git commit -m "docs: add shell build screenshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin phase-1a-design-system
gh pr create -R kwilson21/tally --title "Phase 1a: design system foundations" --body "Closes #DS_ISSUE. Plan: docs/superpowers/plans/2026-09-22-phase-1a-design-system.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

The owner reviews the screenshots and merges.

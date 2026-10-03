| Last Updated: [OWNER INPUT REQUIRED — see publication checklist] · DRAFT — NOT FOR PUBLICATION |
| --- |

# Tally Privacy Policy

**Effective date: [OWNER INPUT REQUIRED — see publication checklist].**

> This working draft uses General Legal's U.S. Privacy Policy template, pinned at commit `6d6805425eabd41bed86fc1e2ec51612760f716c`. Pre-PR 148 baseline behavior below was checked against `a76179f0951e146ed5d6c194579e464f04c1e0eb`; merged PR 148 behavior is described against merge commit `cf90ceffba334cf9ab5439254d5a1b1183db56de` (reviewed head `7eb99b894bc90ce8b74044973829cff16fbe1c5b`). PostHog recording is only a future design; see [replay design](posthog-replay-design.md). This is an unpublished working draft, not legal advice. Complete the shared [publication checklist](publication-checklist.md) before publication.

## Who and what this notice covers

Tally is a household budgeting application. Its configuration names `tally.thesuperhuman.us` for production and `tally-demo.thesuperhuman.us` for the public demo. Production access is gated by Cloudflare Access; app users work with the same shared household dataset.

The demo uses shared sample data. Changes made in the demo may be visible to other demo users. Do not enter real financial information in the demo. Bank linking and feedback submission are disabled in the demo.

## Personal information we collect

### Sign-in, bank, and household information

- **Sign-in:** the email address from the verified Cloudflare Access identity is used as the actor identifier for bank-link records. Before PR 148, feedback stored that identifier; merged PR 148 feedback instead uses an opaque one-hour limiter cookie. The Plaid Link client user identifier is a SHA-256 digest of the email address.
- **Bank and transaction data:** when a bank is linked, Tally receives institution, account, balance, and transaction data from Plaid. The application stores bank connection details, transaction dates and amounts, bank descriptions, merchant names, and related category data in Cloudflare D1. Plaid access tokens are encrypted before storage in D1.
- **Budgeting data:** categories, budget amounts, merchant names and matching rules, transaction notes, categorization choices, and exclusion choices entered or selected in the implemented application.
- **Feedback baseline before PR 148:** the application stored the verified actor email, submission time (`created_at`), type, feeling, message, referring page value, and a broad device/browser label in D1. The broad label is derived from the request's standard `User-Agent` header. A same-origin referring URL could include its query string or fragment; those can contain search or filter state.

### Feedback filing before PR 148

When private filing is configured, a feedback issue is sent to Tally's private GitHub feedback repository. The issue body contains the report type, feeling, page value, device/browser label, and message. It does **not** automatically include the actor email or `created_at` submission time. Before PR 148, the page value could include a same-origin URL's search or fragment.

### Merged PR 148 feedback privacy controls and layout preview

The following behavior is present in merged PR 148. Its Wrangler configuration leaves the diagnostics, replay-link, and layout-preview flags unset, and the demo guard disables these features. Deployed environment settings have not been verified by this draft.

- New submissions use a random first-party `__Host-tally-feedback-limit` cookie to apply the existing hourly submission limit without putting the verified Access email into new feedback rows. The cookie is marked `Secure`, `HttpOnly`, and `SameSite=Strict`, and is set for one hour; feedback-form GETs with a valid cookie reuse it without refreshing that expiry. This is a best-effort per-browser limiter, not a person-level identity or security boundary; a person can clear or manipulate browser cookies. The existing database column is named `actor`, but its value is this random limiter token, not an email. It can link submissions from the same browser during that period. The browser script reads `navigator.userAgent` locally only to derive a coarse device category; the raw string is not submitted in feedback or stored by the Worker. Cloudflare and other network services may still receive the standard HTTP `User-Agent` header.
- Before submission, the browser replaces recognizable emails, phone numbers, URLs, street addresses, account-like numbers, currency amounts, IPv4-formatted addresses, some title-case name patterns, and password/token/API-key/authorization values preceded by a recognized label with placeholders, then shows the cleaned message for review. The Worker repeats message and route sanitization before D1 storage and private GitHub filing, including retries. This is pattern-based minimization only: it can miss arbitrary names, unlabeled credentials, identifying prose, unusual formats, or sensitive details not covered by these patterns. The person must review the cleaned message before sending.
- New feedback rows contain submission time, type, feeling, the cleaned message, an approved route category, and a coarse device category (desktop, mobile, tablet, or unknown). Route categories omit queries, fragments, and record identifiers. If the optional technical-details choice is enabled, the attached context is limited to that route category, coarse device category, and an allowlisted generic browser error name. It excludes raw user-agent strings, dimensions, build identifiers, stack traces, and replay identifiers. Private GitHub issue titles and bodies are built from the same cleaned message and approved fields; retries apply the sanitizer again. The repository is configured private in source, but live repository and deployment settings require confirmation.
- PR 148 contains no PostHog SDK, replay link capture, or active recorder. It ignores any submitted replay identifiers. Do not interpret a random limiter token as an anonymous analytics identifier; the implementation does not use it for analytics.
- The PR 148 layout-preview code uses a strict static-label and layout-marker projection, removing unmarked content and blocking inputs, hidden/file controls, finance content, charts and image-like elements, and private subtrees before rendering. Its feature is hard-disabled because the synthetic browser-pixel and OCR leakage checks could not be run with the available browser dependencies. No actual preview capture is currently enabled or claimed. The earlier PR 148 preview's ten-minute age check limited display eligibility; it was not automatic deletion. The current script removes a stored preview entry only when it runs on the feedback form; otherwise browser storage may remain until the tab session ends or the person clears site data.
- PR 148 separates same-origin return navigation from the approved route category stored with feedback. This draft makes no claim that historical D1 rows or previously filed GitHub issues have been rewritten or scrubbed.

## Information from other services

Plaid supplies bank connection and transaction data. For technical categorization, Tally sends Jev at `api.typesafe.ai` one transaction at a time: the bank's raw transaction name, display merchant name, absolute amount in cents, direction (money out or money in), account type, Plaid category when present, and available household category choices. The request asks Jev for a category and transfer, reimbursement, and income flags. It does not send the transaction date, note, or account name.

Cloudflare Access handles production sign-in. Cloudflare Workers and D1 host the application and its implemented records. Plaid and Jev provide the integrations described above. GitHub receives feedback issue content when private filing is configured. Provider and deployment practices that are not established by application source are listed in the publication checklist.

## How we use and share personal information

The application uses connected bank and transaction data to provide the implemented household budget, account, and transaction features. Jev's response is used for transaction categorization and flags. Household data is available to people authorized through the production Access gate.

Feedback is stored in D1. When private GitHub filing is configured, the Worker sends the cleaned message and approved route, type, feeling, and coarse device fields, then retries eligible unfiled reports on a scheduled run. New feedback rows do not include the verified actor email or replay identifiers. Optional generic error context may be attached only when selected. Pattern-based redaction does not guarantee that every identifying detail is removed.

## Tracking and other technologies

See the [Cookie Notice draft](cookie-notice-draft.md). Tally's current source does not include an analytics or replay SDK. The feedback limiter cookie is described in the Cookie Notice draft. Cloudflare Access supplies authentication for production. When Plaid is configured, the Accounts page loads Plaid Link from `cdn.plaid.com`.

## Retention and your choices

The application offers CSV and Tally JSON downloads for implemented bank and budgeting data. These are app exports, not a complete privacy-request export; they do not include feedback records.

Disconnecting a bank stops future sync and clears the stored encrypted access token. By default, the bank's imported accounts and transactions remain in Tally. If the person selects “Also delete its accounts and transactions,” Tally deletes the related accounts, transactions, and balance history. These controls do not claim to delete feedback rows, already-filed GitHub issues, provider copies, backups, or platform logs.

## U.S. state privacy rights

The applicable rights, scope, exceptions, and request process require legal review. See the publication checklist; this draft does not claim that any particular state-law request mechanism is implemented.

## Other sites and services

Plaid Link and APIs, Jev, Cloudflare Access, and GitHub are separate services. Their own notices and practices may apply when they process information. See the publication checklist for provider and deployment facts that remain to be confirmed.

## Security

The application encrypts Plaid access tokens before storing them in D1. This is an implementation detail, not a broader security guarantee. Other service, backup, and log practices require confirmation in the publication checklist.

## Location, age, changes, and contact

Applicable locations, intended age group, required children's privacy disclosures, the effective date, the legal operator, and contact details are unresolved. See the shared publication checklist. The U.S. template is a drafting basis only; this notice does not assert that U.S. law is the only applicable law.

---

*Template basis: General Legal, Privacy Policy (U.S. Only), `templates/privacy-policy-us/template.md`, commit `6d6805425eabd41bed86fc1e2ec51612760f716c`. The template is released under CC0 1.0. General Legal credit retained; template content adapted for this unpublished draft.*

This template was prepared and made publicly available by General Legal, PC ("General Legal"). It is provided for general reference purposes only and does not constitute, and should not be construed as, legal advice, or an endorsement or review of any particular transaction in which it is used. Use of this template does not create an attorney-client relationship with General Legal. General Legal has not reviewed, and takes no position on, any modifications made to this document or the deal terms it is used to document.

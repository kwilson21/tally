# Privacy and Cookie Notice publication checklist

Internal working checklist for the unpublished [Privacy Policy draft](privacy-policy-draft.md) and [Cookie Notice draft](cookie-notice-draft.md). Resolve these items before publication; the two drafts point here so unresolved facts are not repeated or guessed.

- **Operator and notice administration:** confirm the legal operator and entity details, mailing address, monitored privacy contact, effective/publication date, and how material notice changes will be communicated.
- **Deployment scope and access:** confirm the production domain and service scope, Cloudflare Access membership policy and identity-provider configuration, applicable regions, and the settings that control Access cookies (including whether the optional binding cookie is enabled). Confirm any deployed diagnostics/preview flags. PR 148's Wrangler file has these flags unset; that does not establish live environment values. No PostHog SDK/recorder is included; any future activation must follow [the separate replay design and acceptance gates](posthog-replay-design.md).
- **Current-main and proposed behavior:** preserve the distinction in the drafts between main commit `a76179f0951e146ed5d6c194579e464f04c1e0eb` and draft PR 148 head `e983e521917aaa75afa60ee5d05f76e855ebf273`. Do not imply previously stored or filed feedback has been rewritten.
- **Retention, deletion, backups, and logs:** establish actual periods and deletion/backup behavior for household records in D1, current-main feedback rows (including actor email and `created_at`), new PR 148 feedback rows (including limiter token and `created_at`), private GitHub feedback issues, application/platform logs, and any copies retained by providers. The bank-disconnect controls described in the policy do not delete feedback, existing GitHub issues, provider copies, backups, or logs.
- **Provider practices:** review current processing, storage, retention, and available user controls for Cloudflare/Access, Plaid Link and Plaid APIs, Jev, and GitHub. Use verified provider terms and production configuration; do not infer unverified practices from app source.
- **Legal scope and rights:** determine applicable jurisdictions, intended age group, required children's privacy language, applicable state-law rights, the actual request/response process, and any cross-border data flows that need disclosure. Confirm what the app's CSV and Tally JSON downloads include; they are not a complete privacy-request export and omit feedback rows.
- **Demo notice:** retain a clear warning that the demo uses shared sample data, edits may be visible to other demo users, and real financial information should not be entered. Bank linking and feedback submission are disabled in the demo.

## Template clause mapping

| General Legal template area | Draft section / treatment |
| --- | --- |
| U.S. Privacy Policy introduction and service scope | Privacy draft: “Who and what this notice covers”; operator and scope details are in the checklist above. |
| Personal information and third-party sources | Privacy draft: verified sign-in/bank data/implemented budgeting fields/feedback; Jev request fields are stated explicitly. Unsupported documents and other placeholder destinations are not described as collected data. |
| How information is used and shared | Privacy draft: household budgeting, Jev categorization, D1 feedback and conditional private GitHub filing; feedback email/time are distinguished from the GitHub issue body. |
| Tracking technologies | Privacy draft points to Cookie Notice. Cookie draft lists Access, the proposed feedback limiter cookie, optional Access binding-cookie status, and Plaid Link without assuming unknown provider behavior. |
| Retention and user choices | Privacy draft states the implemented CSV/JSON exports and bank-disconnect choices; no general retention period or feedback/provider deletion promise is made. Unverified retention, backup, and log details remain in this checklist. |
| State rights, other sites, security, location/transfers, children, changes, and contact | Privacy draft preserves these template areas but defers unresolved law, geography, age, contact, cross-border flow, and provider facts to this checklist. |
| Cookie definitions and cookie/provider table | Cookie draft defines cookies and browser storage and describes the Access cookie, proposed one-hour feedback limiter cookie, and unverified/conditional providers. |
| Other technologies and choices | Cookie draft separates current-main URL behavior from the PR 148 proposal, and states preview age-check behavior without claiming automatic deletion. |
| Changes and questions | Cookie draft retains both template sections; process and contact details are listed above. |

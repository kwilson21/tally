# PostHog replay privacy design — not implemented

**Status: design only. No SDK is installed, no recorder runs, and no replay data is being sent by this patch.** Do not enable a recorder until an exact SDK release is pinned and the outbound payload tests below pass.

## Proposed configuration constraints

- Pin an exact `posthog-js` release and validate every option against that release's type declarations and source before adding the SDK.
- Use `maskAllInputs: true` and `maskTextSelector: "*"`. Text may be unmasked only for exact, reviewed static-copy markers through a tested `maskTextFn`. Keep finance views, feedback messages, account identifiers, and dynamic content masked. `maskAllInputs` does not cover hidden and file inputs; explicitly block those elements before serialization.
- Block `data-feedback-private`, `ph-no-capture`, hidden/file controls, and finance, chart, image, SVG, canvas, video, iframe, object, embed, and source elements. Never rasterize the live application DOM.
- If static markup attributes are needed, test `maskAttributeFn` against the pinned release and allow only reviewed class tokens and strictly parsed, URL-free layout style values. Do not set `maskAllElementAttributes`: it supersedes the callback and removes class/style values needed to render the UI.
- Set `recordBody: false` and `recordHeaders: false`. Network URL callbacks replace built-in automatic redaction, so any callback must map URLs to approved route templates and remove query, fragment, and record identifiers. Never record request/response bodies or headers.
- Disable console, structured-log, and automatic-exception capture using options verified for the pinned release. Set `captureJsonLd: false` and `recordCrossOriginIframes: false`; do not enable canvas recording.
- Do not call `identify`, attach feedback text, stacks, raw page URLs, or authentication details to event properties. Use only explicit event/property allowlists. No session ID or replay link is exposed in the feedback form.
- Project-level IP discard must be verified in the actual PostHog project before any future activation. `ip: false` is not a valid substitute. `person_profiles: "never"` still does not make a replay session anonymous; random session IDs can remain linkable.

## Acceptance checks before activation

1. Add synthetic canaries for names, emails, phone numbers, addresses, account/transaction IDs, amounts, URL query/fragment values, hidden/file inputs, DOM attributes, network payloads, exception text, console messages, and JSON-LD.
2. Use an outbound request interceptor that captures every SDK envelope, decompresses it, and asserts no canary appears in any serialized payload. Keep positive controls for approved static labels and basic click/scroll interaction.
3. Verify cross-origin iframe, image-like and canvas content never enters the capture tree. Fail closed if parsing, projection, or serialization errors occur.
4. Do not use live household data or permit network delivery to a project during these tests. Pin and record the exact SDK version and test results.

Official references reviewed: [PostHog session replay privacy controls](https://posthog.com/docs/session-replay/privacy), [network recording](https://posthog.com/docs/session-replay/network-recording), and the pinned [`posthog-js` configuration types](https://github.com/PostHog/posthog-js/blob/abe2924c96a1ddb1d32362dc97bdd9ce121672ce/packages/types/src/posthog-config.ts#L656-L668). These references are design inputs; they do not establish a project-level configuration or validate a future integration.

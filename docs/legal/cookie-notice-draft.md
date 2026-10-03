| Last Updated: [OWNER INPUT REQUIRED — see publication checklist] · DRAFT — NOT FOR PUBLICATION |
| --- |

# Tally Cookie Notice

> This working draft follows General Legal's Cookie Notice template, pinned at commit `6d6805425eabd41bed86fc1e2ec51612760f716c`. It distinguishes current-main source behavior from merged PR 148 behavior. The feedback limiter cookie is present in merged source; confirm deployment before publication. Complete the shared [publication checklist](publication-checklist.md) before publication.

## What are cookies?

Cookies are small data files a service can place in a browser. Similar browser storage, such as `sessionStorage`, is stored separately from cookies and may also hold information between page loads in the same browser tab.

## What cookies and similar technologies are used?

| Technology | Provider and purpose | Where it appears | Duration and control |
| --- | --- | --- | --- |
| `CF_Authorization` authentication cookie | Cloudflare Access uses this cookie to authenticate access to a protected application. Cloudflare documents it as an Access JWT cookie. | Production is configured behind Cloudflare Access. | Exact expiration and domain settings depend on deployment configuration; see the publication checklist. Browser cookie controls can remove it, but doing so may require signing in again. [Cloudflare Access authorization-cookie documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/). |
| `__Host-tally-feedback-limit` feedback cookie | Tally's feedback form uses a random token as a best-effort per-browser hourly limiter, without storing the verified Access email in new feedback rows. It is not a person-level identity or security boundary. | Set when the feedback form is opened; submitted with feedback. | One hour. `Secure`, `HttpOnly`, `SameSite=Strict`, host-only and path `/`. Reopening the form with a valid cookie reuses it without refreshing its expiry. Clearing it resets the browser's limiter identity. |
| Cloudflare Access binding cookie, if enabled | Cloudflare documents an optional binding cookie; this draft does not assert it is enabled. | Depends on deployment configuration. | See the publication checklist for enabled cookies and settings. |
| Plaid Link and provider storage | When Plaid is configured, the Accounts page loads Plaid Link's script from `cdn.plaid.com` and uses it to connect or repair a bank. Application source does not establish what cookies or other identifiers Plaid may use in that flow. | Accounts flow when Plaid is configured. | See the publication checklist for provider behavior and controls. |

The feedback cookie is distinct from Cloudflare Access authentication. This source-code review does not establish cookies or logs set by Cloudflare's deployed edge configuration, Cloudflare Access, or third-party integrations. PostHog recording is not implemented; see the [future replay design](posthog-replay-design.md).

## Other technologies

### Pre-PR 148 baseline

Before PR 148, feedback used the referring page when a person opens feedback. Its page value can include that same-origin URL's query string or fragment, which may contain search or filter state. This is a URL value, not a cookie.

### Merged PR 148 feedback features

PR 148 adds optional generic error context and browser-only layout-preview code. The diagnostics selection attaches an approved route category, coarse device category, and generic allowlisted error name. The browser and Worker apply pattern-based message redaction before storage and filing and show the cleaned message for review; the patterns cover labeled credentials as well as contact, account-like, URL and amount patterns, but can miss arbitrary names, unlabeled credentials, and other sensitive prose. The optional preview is hard-disabled pending synthetic pixel/OCR acceptance. Live deployment settings are not established by this notice.

If the diagnostics feature is enabled, its first-party script runs on application HTML pages and may store an allowlisted generic client-error name in browser `sessionStorage`; the entry is removed when the script runs on the feedback form. The optional diagnostics selection attaches only the approved route category, coarse device category, and generic error name. The browser script reads `navigator.userAgent` locally only to derive a coarse category; the raw value is not submitted in feedback or stored by the Worker. The HTTP request still includes a standard `User-Agent` header to network services. There is no replay-link choice or recorder in this implementation.

The intended layout preview is created only from marked static labels and allowlisted layout properties, with unmarked and finance-related content removed before rendering. It stays in browser `sessionStorage` and is not uploaded or included in feedback. Capture remains hard-disabled until synthetic pixel/OCR checks pass; no current capture or preview is claimed. The earlier PR 148 preview's ten-minute age check limited display eligibility and was not a deletion timer. The current script removes a stored preview entry only when it runs on the feedback form; otherwise browser storage may remain until the tab session ends or the person clears site data.

## Your choices

The PR 148 form provides an optional generic error-context control. The preview is currently disabled. Browser settings let people inspect or clear site storage and cookies; clearing Cloudflare Access cookies may require signing in again. Provider-specific choices and deployment settings remain to be confirmed in the publication checklist.

## Changes

See the publication checklist for the unresolved notice-change date and process.

## Questions

See the publication checklist for the legal operator and contact details.

---

*Template basis: General Legal, Cookie Notice, `templates/cookie-notice/template.md`, commit `6d6805425eabd41bed86fc1e2ec51612760f716c`. The template is released under CC0 1.0. General Legal credit retained; template content adapted for this unpublished draft.*

This template was prepared and made publicly available by General Legal, PC ("General Legal"). It is provided for general reference purposes only and does not constitute, and should not be construed as, legal advice, or an endorsement or review of any particular transaction in which it is used. Use of this template does not create an attorney-client relationship with General Legal. General Legal has not reviewed, and takes no position on, any modifications made to this document or the deal terms it is used to document.

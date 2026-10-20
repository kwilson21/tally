# Receipts: the original app's design, line by line (Oct 19 review)

The owner asked that receipts come off the Later list "as thorough as possible", skipping no detail of the original app's feature (`kwilson21/superhuman-personal-finance`). This review lists every part of it and where each one went in Tally, so nothing is lost. Decision 136 and spec §8.9 are the result.

Sources read in full:
- `docs/designs/RECEIPT-01-user-flows.md` (Feb 7, 2026, draft);
- `docs/designs/RECEIPT-01-tech-design.md` (Feb 2026, draft);
- `django_app/documents/models.py` (the document-ingestion schema, built but never used);
- issues #21 (Epic: Document Ingestion Pipeline), #8 (Email invoice scanning for transaction context) and #23 (Reduce friction for cash entry);
- and, for the owner's second ask, how the Fetch app takes in purchases (part E).

**Where it went** uses these words: **Step 1–6** is a step of Phase 6 (§8.9: read a receipt; split from items; email; bills and invoices; Amazon's order file; connected store accounts, asking Knot first). **Same** means Tally does it as the original said. **Changed** says how and why. **Later** is on the spec's Later list (§12). **Not picked** and **Not needed** give the reason. **The owner's pick** marks one of the four choices the owner made with decision 136 (Oct 19).

## A. RECEIPT-01 user flows

| # | Original | Where it went |
|---|---|---|
| A1 | Mobile-first: every screen drawn at 375px first | Same: each step is drawn at phone width first on the proposals page (DESIGN.md). |
| A2 | Glanceable (<3 s): receipt status visible on the transaction list | Step 1: a small receipt mark on rows with a receipt, drawn in the catalog first. |
| A3 | Simplicity: OCR does the work, the user only corrects | Same: every value read is filled in, dashed, and "Looks right" keeps them all. |
| A4 | No tooltips | Same: Tally explains a page with its one Why? link (decision 121), never tooltips. |
| A5 | Confirmation required: nothing auto-applied | Same, and stricter: Tally never links a receipt to a charge on its own (§8.9). |
| A6 | Composability: reuse Split, Category, Transaction patterns | Same: the split form, the folded category row (decision 131), the Maybe pattern and the review screen (§8.6). |
| A7 | Reused patterns: bottom modal, stacked cards, running total, 2-column category picker, JSON form posts, `every 2s` polling, status dots, toasts | Changed to Tally's: sheets (sheet.js, decision 109), the split form's parts, the category grid, toast + announce. No polling (Clairic answers in seconds) and no JSON posts (plain form fields). |
| A8 | EP-1: "Scan Receipt" in the transaction list header / toolbar | Step 1: "Scan a receipt" beside Add cash on Transactions. |
| A9 | EP-2: receipt icon in a row's actions, pre-linked to that transaction | Step 1: "Add a receipt" in the transaction's edit panel (Tally's rows open the panel; there are no hover actions). |
| A10 | EP-3: "Have a receipt? Scan it to auto-fill splits" inside the split modal | Step 2: the split form offers Add a receipt. |
| A11 | EP-4: Settings section with the forwarding address and a copy button | Step 3. The copy button needs a script, so the address is shown as text to select. |
| A12 | EP-5: "N receipts ready for review" banner on the transaction list | Step 3: waiting receipts join the review screen's questions, which Home already counts (§8.6, §8.8). |
| A13 | Not building: a Receipts tab or page, a receipt button on the Budget page, an onboarding step, a floating button | Same: receipts live with their purchases and on the review screen; the first week doesn't mention them. |
| A14 | Happy path: photo → OCR → review → Accept all → Confirm & Split, ~15 s | Steps 1 and 2. |
| A15 | Upload sheet: Take Photo / Choose from Library, `capture="environment"`, auto-submit on pick | Changed: one file input, which on a phone offers the camera or the library itself; a Read button sends it, because sending on pick needs a script. |
| A16 | Processing state: 3-step progress, thumbnail, timed messages, polling every 2 s with stop rules and a 30 s note | Changed: Clairic answers within seconds, so the sheet waits with HTMX's busy state and an announcement. The receipt is saved before it's read, so leaving loses nothing. |
| A17 | Navigate away or phone locks during OCR → banner on return | Changed: the saved receipt waits on the review screen. |
| A18 | Review page: full page, sticky header, summary card (store, date, total, confidence dot), stacked item cards, desktop two columns with the image | Steps 1–2, drawn on the proposals page; the confidence dot becomes "Tally's guess · N% sure" (§8.6). |
| A19 | Item card: edit name and amount in place, category pill (dashed suggested, solid confirmed), remove ×, swipe to delete | Step 2: same, except swipe (Tally has no gestures; a Remove control instead). |
| A20 | "Accept all suggestions" when 5+ items have suggestions | Changed: "Looks right" is always there, as on every Maybe. |
| A21 | Running total; remainder "Tax & Other" row; red when items exceed the total; Confirm disabled until balanced within $0.01 | Changed (the owner's pick): tax, tip and discount are shared over the parts in proportion, in cents; parts must add up exactly (Tally's split rule has no tolerance); a mismatch names the number to check. |
| A22 | Button says Confirm, or Confirm & Split with 2+ categories | Step 2: one category offers the category instead of a split; the words are picked in design. |
| A23 | Confirmation toast "Receipt processed! Split into N categories" | Same pattern: toast + announce (CLAUDE.md). |
| A24 | Receipt badge; "View receipt" lightbox with pinch-to-zoom; hover thumbnail on desktop | Step 1: the mark; the panel shows the photo small and links to the full file (the phone's own zoom). No hover preview. |
| A25 | Match card "We found a match!", Strong / Possible labels, no numbers shown | Changed: the review lists the charges it could be, in the rule's order (§8.9), and a person picks; no score labels. |
| A26 | Yes, link it / Not a match; several candidates as radio choices | Same: pick one, "Not here yet", and No is remembered (`receipt_not_this_charge`). |
| A27 | Confirm with a match: link, split, attach image, set the display name if confidence > 0.8, toast | Changed: the store is offered as a name suggestion, never set on its own (§7). |
| A28 | Confirm without a match: new manual transaction, re-matched later | Changed (the owner's pick): a card receipt waits for its charge instead; only a cash receipt makes a cash entry. |
| A29 | Attach from a row skips matching | Same (step 1). |
| A30 | Email setup: address made on first visit, copy, Gmail / Outlook / Other instructions, regenerate with confirmation | Step 3. |
| A31 | Inbound: SendGrid/Mailgun webhook (HMAC) → validate sender → find user by address → HTML body or attachment → OCR → auto-match → review | Changed: Email Routing to the Worker's `email()` handler, no third party (step 3). |
| A32 | Pending receipts banner; no push or email alerts | Same idea: the review screen; no notifications. |
| A33 | Sequential review: next pending receipt after each confirm; Skip; "All receipts reviewed!" | Same: the review screen is one item at a time with Skip (§8.6). |
| A34 | OCR fails: Try Again / Enter Manually; never blocked | Same: "Couldn't read it" opens the empty form (§8.9). |
| A35 | Partial success (confidence < 0.7): yellow banner, all fields editable | Changed: each low-confidence value asks to be checked, in the Maybe pattern. |
| A36 | Wrong image: garbage or nothing; discard without "are you sure?" | Changed: "Tally couldn't find a receipt in this photo." (§10); removing follows Tally's delete pattern, picked in design. |
| A37 | Network error: inline message, form kept | Same: decision 72's "Couldn't save. Check your connection and try again." keeps what was typed. |
| A38 | Wrong match: Not a match, never re-shown, Unlink receipt | Same: `receipt_not_this_charge`, and Move or Remove. |
| A39 | Duplicate: "Already has a receipt. Replace it?" | Changed: several receipts per transaction are allowed (Apple bills several purchases as one); a receipt like one already kept (same store, date, total) says so. |
| A40 | No items (gas, parking): attach as reference | Same. |
| A41 | Single-category receipt: no split | Same: the category is offered instead. |
| A42 | 10 MB+ image refused | Changed: 4 MB per photo, Clairic's limit. |
| A43 | HEIC: iOS converts; server accepts HEIC with `pillow-heif` | Changed: UNVERIFIED, checked in the spike; Workers has no Pillow, so converting HEIC would be its own decision. |
| A44 | Cancel after OCR: stays in review; cleaned up after 30 days | Same: 30 days, with a week's notice on the review screen. |
| A45 | Receipt-made transaction, then the Plaid one arrives: merge (Plaid survives, manual one soft-deleted, splits re-applied) | Changed (the owner's pick): no merge; a card receipt waits for its charge, so nothing is counted twice. |
| A46 | One receipt per transaction in Phase 1 | Changed: several allowed. |
| A47 | States PENDING → PROCESSING → REVIEW → CONFIRMED / FAILED; retry makes a new receipt; confirmed receipts immutable | Changed: `to_review`, `waiting`, `kept` (reading is synchronous); a kept receipt can still be moved or removed, as Tally lets every choice be undone. |
| A48 | Transaction lifecycle per receipt state | Same in substance: nothing changes until a person keeps it. |
| A49 | HTMX flow traces A–C | Build detail for the briefs. |
| A50 | Alpine.js state for upload and review | Not needed: no client framework (CLAUDE.md); the server draws the form. |
| A51 | Template inventory, URL structure, view functions | Build detail for the briefs. |
| A52 | Screen reader table: labelled scan button, labelled form, live processing status, item groups, picker `aria-haspopup`, live running total, `aria-disabled` confirm, match card `role="alert"` | Same in Tally's terms (§8.9 Accessibility); a found charge is announced, not an alert, since `role="alert"` is for errors. |
| A53 | Keyboard: tab order, Escape closes popovers, Enter submits, arrows in the picker grid | Same, through keyboard.js and sheet.js (decision 109). |
| A54 | Text + icon + color, 44px targets, focus rings | Same (CLAUDE.md). |
| A55 | Success metrics (completion, splits, uncategorized, time, acceptance, abandonment, match accuracy, forwarding setup, review within 48 h; north star: multi-category purchases split) | Not picked as dashboards for one family; What AI did counts receipts kept, and the spike measures how well Clairic reads. |
| A56 | Phase 1 out: batch upload (never), gallery (never), search (later), auto-split without confirmation, ML training, PDF parsing (Phase 3), multi-page receipts (later), rules made from receipts (Phase 2+) | Same for batch, gallery and auto-split. Search: **Later**. PDF: Changed, read through `toMarkdown` from step 1. Multi-page: Changed, up to four photos. Rules from receipts: **Later** (Tally asks before making any rule, decision 101). |
| A57 | Phase 2 out: automatic matching, background re-matching, threshold tuning UI, unmatch | Same for automatic matching. Changed: waiting receipts are checked after each sync (that is the point of waiting), and a receipt can be moved or removed. No tuning screen. |
| A58 | Phase 3 out: OAuth inbox access, push, retailer parsers beyond five, auto-confirm, email replies | Inbox access: **Later**; forwarding covers new mail (part E, E12). Push and replies: same, none. Retailer parsers: Not needed, since Clairic reads any layout. Auto-confirm: same, never. |
| A59 | Open question 1: production image storage | R2 (`tally-prod-docs`, already made). |
| A60 | Open question 2: OCR provider | Clairic (decision 136). Claude Vision, the original's pick, is not picked: its JSON has to be parsed and checked, and its numbers aren't tied to the receipt or scored, while Clairic's answers are typed, scored and tied to their place in the text, on the platform Tally already runs on. |
| A61 | Open question 3: retention (indefinite / 1 year / 90 days for images) | Kept with its receipt, as decision 66's Later entry said ("attach a photo or PDF of a receipt to a transaction"); reading then deleting it is not picked. |
| A62 | Open question 4: group splits by category | Same: one part per category. |
| A63 | Open question 5: a RECEIPT_OCR transaction source | Changed: a cash entry from a receipt is an ordinary cash entry; the receipt row records where it came from. |
| A64 | Open questions 6–7: MEDIA_ROOT first; thumbnail as its own task | Not needed: R2 binding; no thumbnails (the browser scales the photo). |
| A65 | Appendix: write sequence, round trips | Build detail. |

## B. RECEIPT-01 tech design

| # | Original | Where it went |
|---|---|---|
| B1 | Phased plan: 1 camera/upload + OCR + review; 2 matching + auto-split; 3 email | Steps 1–3, plus step 4 from #21. |
| B2 | Receipt model: user FK and ownership `clean()` | Not needed: one shared household (decision 5); demo and production never share data (§4.1). |
| B3 | Receipt: transaction FK (SET_NULL), image, thumbnail, source camera/upload/email, `email_message_id` | `receipts.transaction_id`; the file in `documents`/R2; no thumbnail; `source` is `photo` or `email` (camera and library can't be told apart and don't need to be); `email_message_id` kept. |
| B4 | Receipt: status, `error_message`, `ocr_raw_response`, overall `ocr_confidence` | Changed: three statuses; no error text stored (nothing from a receipt is logged); `read` keeps Clairic's answers with a confidence per value, not a raw dump. |
| B5 | Receipt: merchant, total, subtotal, tax, tip, date, currency USD, Decimal(19,4) | Same fields, in integer cents (CLAUDE.md), plus discount, card last four, order number, and for bills the amount due and due date. Other currencies: **Later**. |
| B6 | Receipt: `match_confidence`, `matched_at`, `auto_split_applied`, timestamps | Changed: `kept_by`, `kept_at`, `read_at`, `created_at`; a split shows on the transaction itself. |
| B7 | Line item: name, quantity, unit price, total, suggested and confirmed category, sort order | `receipt_items`: name, amount, category with its source and confidence, position. Quantity and unit price are not needed for a split. |
| B8 | OCR service: Claude Vision, base64 image, JSON prompt, JSON-in-markdown fallback, several date formats, media type by extension | Changed: one Clairic call with typed fields (no parsing), ISO dates, `reference_date`; the type is read from the file's first bytes. |
| B9 | Prompt rules: positive amounts, quantity defaults to 1, null when unreadable, every item, tax and tip not items | Same where they apply: Clairic returns null when it can't tell, and the items field leaves out tax, tip and discounts. |
| B10 | Circuit breaker (5 failures, 60 s) and retry with backoff | Changed: a failed read opens the form to type; emailed receipts get three tries over the nightly runs; a daily cap bounds spending. |
| B11 | Matching: candidates ±5 days, unmatched, not split children; score amount 0.40 / date 0.30 / merchant 0.30; auto-match ≥ 0.85, suggest ≥ 0.50 | Changed: a rule that fits in a sentence (5 days; the total, ±$2, or plus a tip up to 30%; ordered by exact amount, the card's last four, nearest date), and a person always picks. Split parts aren't listed, as in the original; charges that already have a receipt come last instead of being dropped. |
| B12 | Merge rules: receipt name if confident and none set; bank amount and date win; category from items; notes appended, never overwritten | Same for amount and date (decision 66) and category. Changed: the name is a suggestion; the note is offered only when empty, so a person's note is never touched. |
| B13 | Auto-split: category from rules, then keywords in category names, then the parent's; remainder split in "Other" | Changed: Jev guesses each item's category in one call per receipt (**CLAUDE.md** rule extended); tax and tip shared in proportion (the owner's pick). |
| B14 | Image service: auto-orient, strip EXIF, resize to 2,000 px, JPEG q90, 300×400 thumbnails | Changed: EXIF removed except orientation; no resizing unless the spike finds the family's photos over 4 MB (then its own decision); no thumbnails. |
| B15 | Async tasks (Procrastinate) for OCR and thumbnails | Not needed: a photo is read in the request; an email is read when it arrives, with nightly retries. |
| B16 | Views: upload, status, review, confirm, delete, match, attach; inbound webhook stub | Build detail; the same jobs exist in §8.9. |
| B17 | Accepted types JPEG, PNG, HEIC, HEIF, WebP; 10 MB | Changed: JPEG, PNG, WebP (Clairic's), PDF; 4 MB a photo. |
| B18 | Storage: local, then S3; delete image after confirm; why not base64 | R2. Delete-after-confirm: not picked (A61). |
| B19 | Provider table (Claude Vision, Mindee, Veryfi, Google Vision, Tesseract) and cost (~$0.01 a receipt) | Clairic at $0.10 per million input tokens and nothing for output; the spike measures a receipt's real cost. |
| B20 | Security: user isolation, MIME + Pillow verify, EXIF, rate limit 20/h, API key in env, CSP img-src, CSRF | Isolation not needed (B2); first-bytes check; EXIF; a cap of 100 reads a day; no key (a binding); files served same-origin behind Access with `nosniff`; Hono's csrf middleware (§10). |
| B21 | Additive migrations with dependencies | Same: numbered D1 migrations. |
| B22 | Performance: upload < 500 ms then async; badge via an EXISTS annotation; matching query cost | Changed: the read waits a few seconds; the receipt mark's lookup and the matching query are build details. |
| B23 | Tests: unit (parsing, dates, scoring, remainder, rules, EXIF, resize, thumbnail), integration (upload, reject, review, confirm, link, split, delete, isolation, polling, attach), factories | Tally's TDD: pure tests for cents, sums and tax sharing; route tests in the Workers runtime with a fake `AI` (as the name tests do); E2E for scanning a receipt. |
| B24 | Config: API key, URL, model, timeout, MEDIA settings, Pillow to production | Not needed: the `AI` and `DOCS` bindings, no secret (§4.2). |
| B25 | UI: entry points, eight templates, camera markup, review layout | Steps 1–2, drawn on the proposals page. |
| B26 | Risks: accuracy, downtime, disk, sensitive data, sums, false matches, Pillow CVEs, rate limit | Accuracy: the spike and the Maybe pattern. Downtime: the empty form. Disk: R2. Sensitive data: EXIF, Access, no account numbers kept. Sums: tax sharing. False matches: a person picks. Pillow: no image library. Rate: the daily cap. |
| B27 | Rollout: feature flag, alpha / beta (50+ receipts, > 80% accurate) / GA (S3, matching validated) | Changed: the Read receipts switch; the spike's gate (date and total right on 18 of 20); the demo first, then an owner-approved production deploy. |
| B28 | Monitoring: failure rate, latency, circuit state, disk | Not picked as alerts; logs keep a count and an error code only. |
| B29 | File layout | Build detail. |

## C. The document model (`documents/models.py`)

| # | Original | Where it went |
|---|---|---|
| C1 | Document source: camera, upload, email_forward, email_scan | `photo` and `email`; email_scan (reading the inbox) is **Later** (part E, E12). |
| C2 | Document type: receipt, invoice, bill, statement | `kind`: `receipt` or `bill` (an invoice still to pay is a bill; a paid one is a receipt). Statements stay on the Later list as a second transaction source. |
| C3 | Match strategy: auto_match, standalone, manual_link | Card (waits for its charge), cash (a cash entry), and from a transaction's panel. |
| C4 | Status: pending, processing, extracted, reviewed, applied, failed | `to_review`, `waiting`, `kept` (A47). |
| C5 | `file`, `email_raw` | The file in R2; the raw email isn't kept, only the receipt's text and its attachments (step 3). |
| C6 | `extracted_data` JSON, `extraction_confidence` | `read`, with a confidence per value. |
| C7 | Links to a transaction, a recurring expense and a budget entry | `transaction_id`, `bill_id`, `planned_expense_id` (step 4). |
| C8 | Line item: description, quantity, unit price, total, category | `receipt_items` (B7). |
| C9 | TransactionMatch: receipt vs Plaid transaction, auto/manual, suggested/confirmed/rejected/merged, confidence | No merge (A45); "rejected" is `receipt_not_this_charge`; "suggested" is the review question. |
| C10 | EmailIngestionAddress: one per user, token, active flag, `receipts+token@` | One per household (decision 5), its random part in `household_settings`; making a new one retires the old (step 3). |

## D. Issues

| # | Original | Where it went |
|---|---|---|
| D1 | #21 Phase 1: photo or file, OCR (store, date, total, items), review, match or create | Step 1. |
| D2 | #21 Phase 2: snap-to-split, using the split fields and the category service | Step 2. |
| D3 | #21 Phase 3: a bill or invoice photo becomes a one-time or recurring expense (amount, due date, payee) | Step 4: Plan an expense, or a bill (new, or the matching one's amount from this month on). |
| D4 | #21 Phase 4: email forwarding first; inbox scanning (IMAP/OAuth) later | Step 3; inbox scanning is **Later** (part E, E12). |
| D5 | #21 metrics: % split, < 30 s, auto-match > 70% | As A55. |
| D6 | #21 notes: RECEIPT_OCR source, split fields, category service, `RECEIPT_INGESTION_ENABLED` flag | As A63, B13 and B27. |
| D7 | #8 problem: PayPal, Apple and Amazon charges with generic names | Step 1: the receipt's store and items are offered as the name and "what it was" (Fill in details, decision 103). |
| D8 | #8 principles: privacy-first (no whole-inbox scan), user-initiated, < 10 s, works offline | Same for the first three. Offline: Not picked; the server owns all state, and a failed send keeps the form (decision 72). |
| D9 | #8 option A, screenshot drop | Step 1: screenshots are photos. |
| D10 | #8 option B, share sheet | **Later**: a web page can't be a share target on iPhone; it needs an installed app. |
| D11 | #8 option C, a forwarding address (and auto-made Gmail/Outlook filters) | Step 3, with filters the family makes in Gmail; filters made by Tally through Gmail's or Outlook's API would need inbox access (**Later**, E12). |
| D12 | #8 option D, selective email access (OAuth, one label) | **Later** (E12): forwarding brings new mail without inbox access. |
| D13 | #8 option E, browser extension | Not picked: desktop only, and another thing to install. |
| D14 | #8 OCR: on-device (Apple Vision, ML Kit) or cloud; Veryfi, Taggun | Clairic (A60); on-device needs an app. |
| D15 | #8 sources: PayPal, Apple, Amazon, Google Play, subscriptions, general stores | Any layout Clairic can read; a subscription is Fill in details' kind (§8.6). |
| D16 | #8 data: actual merchant, items, amounts, date, order or invoice number | Same, all in `receipts`. |
| D17 | #8 UX: "Add Receipt" on the transaction; "Suggested name: Spotify Premium" with Use / Edit / Skip | Step 1: Add a receipt in the panel; the name suggestion "From the receipt" in the Maybe pattern. |
| D18 | #8 metrics: completion > 60%, < 15 s, > 90% accuracy, > 70% name acceptance | As A55. |
| D19 | #23: quick-add a cash purchase, minimal fields, "receipt snap creates a manual transaction" | Step 1's cash path makes the cash entry from the receipt; Add cash itself is unchanged. |

## E. Fetch, and connecting store accounts

The owner pointed to Fetch (fetch.com), which takes in receipts and also connects store accounts such as Walmart and Amazon. A research pass on Oct 19 read Fetch's help center, privacy policy, App Store listing and press (sources below; help-center dates are each article's last edit). What Fetch does, and where each part went:

| # | Fetch | Where it went |
|---|---|---|
| E1 | Paper receipts: the store, date and total are required; several photos for a long receipt; Fetch's own text reading maps each item to a product catalog | Step 1, same (up to four photos). No product catalog: Tally needs each item's category, not its product, so Jev guesses categories. |
| E2 | A receipt can be corrected for 3 days and never deleted | Changed: a person can change or remove a receipt at any time. |
| E3 | Only register receipts; utility, medical and service bills, returns, prescriptions and handwritten receipts are refused | Changed: bills and invoices are step 4. Return receipts: **Later**. |
| E4 | 14 days to submit, 35 receipts a week, duplicates checked across all users, a fraud team, the phone's location for fraud | Not needed: those guard a rewards program. Tally caps reads at 100 a day, checks duplicates within the household, and removes a photo's location. |
| E5 | eReceipts by connecting the inbox: Gmail by OAuth under Google's Limited Use rules (a restricted scope, so a yearly security assessment), Yahoo under an approved developer agreement, iCloud with an app-specific password the person pastes in; AOL and Outlook unconfirmed | **Later** (E12): Tally takes forwarded mail instead (step 3). |
| E6 | The connected inbox is checked for about 200 stores' receipt emails, 30 days back, several times a day; found receipts are listed and the person submits them | Changed: a mail filter the family sets up forwards store receipts to the household's address on their own (step 3), and they wait on the review screen. |
| E7 | Forwarded receipts are refused | Changed: forwarding is Tally's way in, so Tally never needs the inbox. |
| E8 | Store accounts (Amazon, Albertsons, Costco, Instacart, Meijer, Sam's Club, Target, Uber Eats, Walmart; Chewy, DoorDash and Sprouts for some): the person signs in with the store's own email and password inside Fetch's app, which then reads their orders "as your agent", 30 days back, several times a day; Costco and Walmart ask to sign in again often; no vendor is named | Step 6: the owner asks Knot first (E12). |
| E9 | Fetch Shop (affiliate links through Button), a browser extension, linked offers, fuel through PDI, restaurants through Rewards Network, a Fetch credit card, GoodRx | Not needed: rewards features, not budgeting. |
| E10 | Never asks for bank or card details | Changed: Tally has the family's bank charges (Plaid), which is what lets a receipt find its charge; Fetch can't match receipts to spending at all. |
| E11 | Shares and sells purchase data with brands and advertising partners (its privacy policy and App Store label) | Not picked: everything a receipt gives Tally stays in the family's own Cloudflare account and is shared with no one. |

**E12. The ways to "connect places", and what each would take.** A second research pass (Oct 19) looked at what a one-family app on Workers can actually use. Facts and sources are in `docs/verified-assumptions.md` items 10f–10k.

| Way | What it gives | What it needs | Where it went |
|---|---|---|---|
| Typing a store's password into Tally, as Fetch does | Each store's orders | Holding the family's store passwords or sessions, two-factor prompts, frequent sign-ins again | Not picked: Tally never asks for another site's password. |
| Knot TransactionLink | Item-level orders from Amazon, Walmart, Target and others, synced daily, by webhook | A sales contract (no public price), Knot's 328 KB script in a frame where the family signs in to each store, a webhook route outside Access, a decision for the new script and vendor | Step 6 (the owner's pick): the owner asks Knot for access and a price now; nothing is built until a decision of its own approves Knot, its script and its cost. |
| Gmail filter forwarding to the household's address | New receipt emails as they come, from any store that emails one | Confirming the address in Gmail (Tally shows Gmail's confirmation), Email Routing, `postal-mime` | Step 3. |
| Amazon's "Request your data" order file | Every Amazon order's items, prices and tax | A person requests it and uploads the CSV now and then | Step 5, if the spike shows the file is easy to get (the owner's pick). Needed because Amazon's emails dropped their items on 2026-07-08. |
| Gmail's API as a personal-use app, or an Apps Script in the owner's account | Older receipts as well as new ones | A Google Cloud project and an OAuth token kept as a secret (or a script outside the repo), Pub/Sub or polling, the unverified-app warning | Later: forwarding covers new mail. |
| Microsoft Graph (Outlook.com), IMAP (iCloud, Yahoo) | Older receipts from those inboxes | An app registration and tokens, or an app password held as a secret and an IMAP client written by hand | Later. |
| Walmart, Target, Costco directly | Their in-store and online purchases appear in each account (Walmart about a year, Target about a year, Costco two years) | Nothing offered to other apps | Not possible except through Knot; paper receipts and emailed ones come in through steps 1 and 3. |

Sources: Fetch help center articles [How to Snap Receipts](https://help.fetch.com/hc/en-us/articles/115015779467-How-to-Snap-Receipts) (2026-07-29), [Why Was My Receipt Not Accepted?](https://help.fetch.com/hc/en-us/articles/360046855734-Why-Was-My-Receipt-Not-Accepted) (2026-04-15), [Supported eReceipt Emails](https://help.fetch.com/hc/en-us/articles/360047696834-Supported-eReceipt-Emails-iOS-and-Android) (2024-12-19), [Connecting iCloud Email Domains](https://help.fetch.com/hc/en-us/articles/52212130206227-Connecting-iCloud-Email-Domains) (2026-06-03), [Supported eReceipt Retailers](https://help.fetch.com/hc/en-us/articles/360023014893-Supported-eReceipt-Retailers-on-Fetch) (2026-09-24), [eReceipt Eligibility Requirements](https://help.fetch.com/hc/en-us/articles/360057602114-eReceipt-Eligibility-Requirements) (2024-03-11), [How to Earn Points on Online Purchases](https://help.fetch.com/hc/en-us/articles/360023014413-How-to-Earn-Points-on-Online-Purchases) (2026-07-24), [Reauthenticating eReceipt Connections](https://help.fetch.com/hc/en-us/articles/52034282371859-Reauthenticating-eReceipt-Connections) (2026-05-28), [Scanning Experience Improvements](https://help.fetch.com/hc/en-us/articles/24114855074451-Scanning-Experience-Improvements) (2026-05-14); [Fetch Privacy Policy](https://fetch.com/privacy-policy) (revised 2026-10-13); [Fetch FAQs](https://www.fetch.com/faq); [Fetch on the App Store](https://apps.apple.com/us/app/fetch-americas-rewards-app/id1182474649) (4.66.0); [Fetch's receipt technology](https://business.fetch.com/newsroom/fetch-launches-new-world-leading-receipt-scanning-technology) (2023-03-07); [Google's Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) (2026-09-10); [Yahoo developer access](https://senders.yahooinc.com/developer/developer-access).

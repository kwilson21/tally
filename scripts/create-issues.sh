#!/usr/bin/env bash
# One-time: creates the Phase 0-4 issues. Safe to read; do not re-run (it would duplicate issues).
set -euo pipefail
R=kwilson21/tally
mk() { gh issue create -R "$R" --title "$1" --milestone "$2" --body "$3"; }

P0="Phase 0: Setup"
mk "Worker skeleton, tests, lint, and CI" "$P0" "Spec §4, §11. Plan: docs/superpowers/plans/2026-09-22-phase-0-setup.md Tasks 1-5."
mk "CLAUDE.md, README, ROADMAP" "$P0" "Spec §2, §11. Plan Tasks 6-7."
mk "Verify spec §13 assumptions against docs" "$P0" "Spec §13. Plan Task 9. Output: docs/verified-assumptions.md."

P1="Phase 1: Core demo live"
mk "Wireframes: Home, Transactions, demo pages (390px + 1280px)" "$P1" "Spec §8. Owner approves before UI code."
mk "D1 schema and migrations" "$P1" "Spec §5. All tables; money as integer cents."
mk "Money utilities: cents parse/format" "$P1" "Spec §5, §6. Pure functions, unit-tested."
mk "Budget math: spent, left, uncategorized, income, safe to spend" "$P1" "Spec §6. Pure functions, unit-tested. The bills term in safe to spend is zero until Phase 3 adds bills."
mk "Seed household (Rivera family), relative dates" "$P1" "Spec §9. Covers Phase 1 features; later phases extend it."
mk "Home screen" "$P1" "Spec §8 Home. Features 1 (and bills section once Phase 3 lands)."
mk "Transactions list: search and filters" "$P1" "Spec §8 Transactions. Feature 3."
mk "Transaction edit panel: category, merchant rule, rename, note" "$P1" "Spec §7, §8. HX-Trigger toast + announce."
mk "Jev categorization module and confidence threshold" "$P1" "Spec §7. Only via src/ai/categorize.ts. One fetch call per transaction (category + flags). Nightly retry."
mk "Demo banner, Things to try, How it works page" "$P1" "Spec §8 Demo only, §9."
mk "Nightly demo reset (cron)" "$P1" "Spec §4.1, §9."
mk "Demo environment: D1, R2, deploy, demo.thesuperhuman.us" "$P1" "Spec §4.1, §11. Show DNS records to owner before creating. Verify HTTPS, routes, console."

P2="Phase 2: Family on the core"
mk "Plaid client and Link (create/exchange tokens)" "$P2" "Spec §4, §10. Plaid Link is the only third-party JS."
mk "Encrypt Plaid access tokens (AES-GCM)" "$P2" "Spec §10. Key via wrangler secret."
mk "Transactions sync with atomic cursor save" "$P2" "Spec §10. D1 batch: rows + cursor together."
mk "Plaid webhook route with signature verification" "$P2" "Spec §10. Plaid-Verification JWT (ES256) checked against /webhook_verification_key/get. Only path bypassing Access (Bypass policy)."
mk "Daily sync and categorization-retry cron" "$P2" "Spec §4, §10."
mk "Fix connection (Link update mode)" "$P2" "Spec §8 Accounts, §10."
mk "Cloudflare Access for family; record who changed what" "$P2" "Spec §4, §5. Identity from the verified Cf-Access-Jwt-Assertion JWT, never the plain email header."
mk "Production environment deploy" "$P2" "Spec §4.1. Owner stores secrets. Hostname decided with owner; finance.* DNS only with explicit approval."
mk "Family trial week and Phase 2 review" "$P2" "Spec §11 finish line."

P3="Phase 3: Bills, exclusions, splits"
mk "Bills: create, edit, deactivate, status" "$P3" "Spec §6, §8 Bills. Feature 2."
mk "Bill matching with bill_payments (one-to-one, date window)" "$P3" "Spec §6.1. Unit-test every candidate rule and tie-break."
mk "Exclusions: toggle and defaults from Jev flags" "$P3" "Spec §6. Feature 5."
mk "Splits: create/remove, children must sum to parent" "$P3" "Spec §6. Feature 4."
mk "Extend seed data for bills, exclusions, splits" "$P3" "Spec §9, §6.1 demo cases."

P4="Phase 4: Trends, balances, documents, name suggestions"
mk "Trends: 6-month category chart (server SVG)" "$P4" "Spec §8 Trends. Feature 6."
mk "Balances, balance history, net-worth chart" "$P4" "Spec §5, §8 Accounts. Feature 7."
mk "Documents in R2: upload, list, download, delete" "$P4" "Spec §8 Documents. Feature 8."
mk "Merchant name suggestions (Workers AI)" "$P4" "Spec §7. Only via src/ai/suggest-name.ts; accept/reject."
mk "Extend seed data for trends, balances, documents" "$P4" "Spec §9."
mk "Final review: all 8 features in both environments" "$P4" "Spec §3, §11."

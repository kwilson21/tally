# Tally

A family budgeting app. It pulls in bank transactions, sorts them into categories with a small AI model, and shows how much is left to spend this month.

- **Demo:** https://demo.thesuperhuman.us (fake data; coming in Phase 1)
- **Design:** [spec](docs/superpowers/specs/2026-09-22-tally-design.md) · [decisions](docs/decisions.md) · [roadmap](ROADMAP.md)

## How it works

One small TypeScript server on Cloudflare builds each page, stores data in a SQLite database (D1), pulls bank data from Plaid, and uses two AI models: Jev for categories and Workers AI for merchant names. Plain code does all the money math.

## Run locally

    npm install
    cp .dev.vars.example .dev.vars   # fill in values; never commit this file
    npm run dev

## Checks

    npm run typecheck && npm run lint && npm test

## Deploy

Deploys are manual and owner-approved:

    npx wrangler login
    npx wrangler deploy --env demo

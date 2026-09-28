#!/usr/bin/env bash
# Walks the owner through putting Tally into production (#23), one step at a time.
# Each step says what it does, shows its command, and runs only when you answer y.
# Secrets are typed at wrangler's own prompt, so they never appear on screen or in shell history.
# Run it from the repo root on your own machine, logged in to wrangler: bash scripts/production-setup.sh
set -euo pipefail

ENV=production
HOST=tally.thesuperhuman.us

bold() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# step "title" "what it does" command...
step() {
	local title=$1 what=$2
	shift 2
	bold "$title"
	printf '%s\n\n  $ %s\n\n' "$what" "$*"
	while true; do
		read -r -p "Run it? [y = run, s = skip, q = quit] " answer
		case $answer in
		y) "$@" && return 0 || { echo "That step failed. Fix it and run this script again; finished steps are safe to repeat."; exit 1; } ;;
		s) echo "Skipped."; return 0 ;;
		q) echo "Stopped. Run the script again to carry on."; exit 0 ;;
		esac
	done
}

# A setting with a fixed value: piped in, so there's nothing to type.
put_value() { printf '%s' "$2" | npx wrangler secret put "$1" --env "$ENV"; }

bold "Tally production setup: $HOST"
echo "Cloudflare Access for $HOST must already exist (Claude sets it up and sends you the team domain and AUD tag)."
echo "Have these ready: your production Plaid client ID and secret, your Jev API key, and a password manager."

step "1. Check you're logged in" \
	"Shows which Cloudflare account wrangler will change. It should be yours." \
	npx wrangler whoami

step "2. Plaid client ID" \
	"Paste your PRODUCTION Plaid client ID at the prompt. If wrangler asks to create the Worker tally-production, answer yes." \
	npx wrangler secret put PLAID_CLIENT_ID --env "$ENV"

step "3. Plaid secret" \
	"Paste your PRODUCTION Plaid secret (not the Sandbox one) at the prompt." \
	npx wrangler secret put PLAID_SECRET --env "$ENV"

bold "Before step 4: make the encryption key"
echo "Run this in another terminal and save what it prints in your password manager as \"Tally token encryption key\":"
echo
echo "  $ openssl rand -base64 32"
echo
echo "Keep that copy. If the key is ever lost, every bank has to be linked again."

step "4. Token encryption key" \
	"Paste the key you just saved at the prompt. It encrypts each bank's access token in the database." \
	npx wrangler secret put TOKEN_ENCRYPTION_KEY --env "$ENV"

step "5. Jev API key" \
	"Paste your Jev API key at the prompt. It suggests categories for new transactions." \
	npx wrangler secret put JEV_API_KEY --env "$ENV"

step "6. Plaid environment" \
	"Sets PLAID_ENV to \"production\". Anything else means Plaid Sandbox (decision 53). Nothing to type." \
	put_value PLAID_ENV production

step "7. Plaid webhook address" \
	"Tells Plaid where to send \"new transactions\" notices. Nothing to type." \
	put_value PLAID_WEBHOOK_URL "https://$HOST/webhooks/plaid"

step "8. Access team domain" \
	"Paste the team domain Claude sent you (it looks like yourname.cloudflareaccess.com)." \
	npx wrangler secret put ACCESS_TEAM_DOMAIN --env "$ENV"

step "9. Access AUD tag" \
	"Paste the AUD tag Claude sent you: the long string that identifies Tally's Access application." \
	npx wrangler secret put ACCESS_AUD --env "$ENV"

step "10. Build the database tables" \
	"Creates Tally's tables in the empty tally-production database. Safe to repeat: finished migrations are skipped." \
	npx wrangler d1 migrations apply DB --env "$ENV" --remote

# Deploys only once every setting from steps 2–9 is set and step 10 left nothing to apply,
# so a skipped step can't put Tally live without its sign-in check or its tables.
REQUIRED="PLAID_CLIENT_ID PLAID_SECRET TOKEN_ENCRYPTION_KEY JEV_API_KEY PLAID_ENV PLAID_WEBHOOK_URL ACCESS_TEAM_DOMAIN ACCESS_AUD"
deploy_when_ready() {
	local secrets migrations missing=""
	secrets=$(npx wrangler secret list --env "$ENV" --format json) || return 1
	for name in $REQUIRED; do
		grep -q "\"$name\"" <<<"$secrets" || missing="$missing $name"
	done
	if [ -n "$missing" ]; then
		echo "Not deploying: these settings aren't set yet:$missing. Run their steps first."
		return 1
	fi
	migrations=$(npx wrangler d1 migrations list DB --env "$ENV" --remote) || return 1
	if ! grep -q "No migrations to apply" <<<"$migrations"; then
		echo "Not deploying: the database tables aren't built yet. Run step 10 first."
		return 1
	fi
	npx wrangler deploy --env "$ENV"
}

step "11. Deploy" \
	"Checks every setting is set and the tables are built, then puts Tally live at https://$HOST. The first deploy also creates its DNS record and certificate." \
	deploy_when_ready

bold "Done"
echo "Open https://$HOST: Cloudflare Access should ask you to sign in, then show Home."
echo "Then go to More → Accounts and press Link a bank."

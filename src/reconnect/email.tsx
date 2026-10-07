import { renderToString } from "hono/jsx/dom/server";

export type ReconnectEmailInput = {
	bank: string;
	lastSyncedAt: string | null;
	accounts: { name: string; mask: string | null }[];
};

function lastSync(lastSyncedAt: string | null, timeZone: string): string {
	if (!lastSyncedAt) return "before Tally recorded the last sync time";
	const date = new Date(`${lastSyncedAt.replace(" ", "T")}Z`);
	if (Number.isNaN(date.getTime()))
		return "before Tally recorded the last sync time";
	return new Intl.DateTimeFormat("en-US", {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		timeZone,
	})
		.format(date)
		.replace(",", " at");
}

function AccountChip({ name, mask }: { name: string; mask: string | null }) {
	return (
		<span style="display:inline-block;padding:8px 12px;border:1px solid #e8e3da;border-radius:999px;margin:4px;color:#0e0e0e">
			<span aria-hidden="true">
				{name}
				{mask ? ` ••${mask}` : ""}
			</span>
			<span style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0">
				{mask ? `${name}, ending in ${mask}` : name}
			</span>
		</span>
	);
}

export function ReconnectEmail({
	input,
	timeZone,
}: {
	input: ReconnectEmailInput;
	timeZone: string;
}) {
	return (
		<html lang="en">
			<body style="margin:0;background:#fbf8f2;color:#0e0e0e;font-family:Arial,sans-serif">
				<main style="max-width:560px;margin:0 auto;padding:32px 24px">
					<p style="font-size:14px;color:#4a4a4a">Tally</p>
					<h1 style="font-family:Georgia,serif;font-size:28px">
						{input.bank} needs you to sign in again
					</h1>
					<p>
						Tally hasn't been able to sync {input.bank} since{" "}
						{lastSync(input.lastSyncedAt, timeZone)}.
					</p>
					<p style="color:#4a4a4a">Not syncing</p>
					<div>
						{input.accounts.map((account) => (
							<AccountChip {...account} />
						))}
					</div>
					<p style="margin-top:28px">
						<a
							href="https://tally.thesuperhuman.us/accounts"
							style="display:inline-block;background:#ae5534;color:#ffffff;padding:14px 20px;border-radius:12px;text-decoration:none"
						>
							Open Accounts
						</a>
					</p>
					<p style="font-size:13px;color:#4a4a4a;margin-top:32px">
						Turn off in Settings
					</p>
				</main>
			</body>
		</html>
	);
}

export function renderReconnectEmail(
	input: ReconnectEmailInput,
	timeZone: string,
) {
	const subject = `${input.bank} needs you to sign in again`;
	const text = `${input.bank} needs you to sign in again\n\nTally hasn't been able to sync ${input.bank} since ${lastSync(input.lastSyncedAt, timeZone)}.\n\nNot syncing\n${input.accounts.map(({ name, mask }) => `${name}${mask ? `, ending in ${mask}` : ""}`).join("\n")}\n\nOpen Accounts: https://tally.thesuperhuman.us/accounts\n\nTurn off in Settings`;
	return {
		subject,
		html: renderToString(<ReconnectEmail input={input} timeZone={timeZone} />),
		text,
	};
}

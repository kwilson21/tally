import { Button } from "./button";
import { Icon } from "./icons";
import { MoneyInput } from "./money-input";

export function SavingsGoalSheet({
	value,
	error,
	month,
	closeAttrs,
}: {
	value: string;
	error?: string;
	month: string;
	closeAttrs: Record<string, string>;
}) {
	return (
		<>
			<div class="flex items-center gap-3">
				<Icon name="bank" class="size-7" />
				<h2
					id="savings-goal-sheet-title"
					class="font-serif text-3xl font-semibold"
					tabindex={-1}
				>
					Savings
				</h2>
			</div>
			<p class="text-muted">
				Set aside from Safe to spend at the start of every month.
			</p>
			<form
				method="post"
				action="/savings-goal"
				class="mt-4 flex flex-col gap-4 border-t border-rule pt-4"
				hx-post="/savings-goal"
				hx-disable="findAll button[type=submit]"
				hx-indicator="#savings-goal-save"
				hx-target="#page"
				hx-select="#page"
				hx-swap="outerHTML"
			>
				<MoneyInput
					id="savings-goal"
					name="goal"
					label={`Save each month, from ${month} on`}
					value={value}
					error={error}
					autofocus
				/>
				<div class="mt-2 grid grid-cols-2 gap-3">
					<Button href="/" kind="secondary" class="w-full" {...closeAttrs}>
						Cancel
					</Button>
					<Button
						id="savings-goal-save"
						type="submit"
						class="w-full"
						busyLabel="Saving…"
					>
						Save
					</Button>
				</div>
			</form>
		</>
	);
}

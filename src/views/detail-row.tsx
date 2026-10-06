import type { Child } from "hono/jsx";
import { Icon } from "./icons";

/** One of the four transaction details: its source stays visible and an unkept guess is dashed. */
export function DetailRow({
	id,
	label,
	value,
	source,
	guessed = false,
	open = false,
	children,
}: {
	id: string;
	label: string;
	value: string | null;
	source: "guess" | "bank" | "person";
	guessed?: boolean;
	open?: boolean;
	children?: Child;
}) {
	return (
		<details
			id={id}
			data-detail-row={id}
			class="group border-b border-rule"
			open={open}
		>
			<summary class="flex min-h-11 cursor-pointer list-none items-center gap-4 py-2 [&::-webkit-details-marker]:hidden">
				<span class="min-w-0 flex-1">
					<span class="block font-medium">{label}</span>
					<span class="block text-sm text-muted">
						{source === "guess"
							? "Tally's guess"
							: source === "bank"
								? "From your bank"
								: "Your choice"}
					</span>
				</span>
				<span
					class={`ml-auto flex min-w-0 items-center gap-1 text-right ${guessed ? "underline decoration-muted decoration-dashed underline-offset-4" : ""}`}
				>
					{label === "Name" && guessed && source === "guess" && (
						<Icon name="sparkles" class="size-4 shrink-0" />
					)}
					<span class="truncate">{value || "Add"}</span>
				</span>
				<Icon
					name="chevron-right"
					class="size-5 shrink-0 text-muted transition-transform group-open:rotate-90 motion-reduce:transition-none"
				/>
			</summary>
			{children && <div class="pb-4 pt-2">{children}</div>}
		</details>
	);
}

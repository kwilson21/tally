// The notify control (decision 148, N1): "Notify me on this device" under Home's first-week setup, while the first questions are not
// yet open. One wrapper, data-notify, holds four states, each hidden until push.js shows the one that applies (Off, On, the iPhone
// hint, Blocked). With no JavaScript, or in a browser without Web Push, all four stay hidden, so nothing shows. A catalog drawing
// passes `shown` to un-hide one state (only catalog drawings do). push.js finds the control by [data-notify] alone, so the
// Home Screen page (#772) can draw it with no change here. A refused tap shows the Blocked line and moves focus to it, so the
// words are read once; there is no alert of its own.

import { Button } from "./button";
import { Icon } from "./icons";

/** The four states: Off (the button), On, the iPhone hint, and Blocked (quiet). */
export type NotifyShown = "off" | "on" | "iphone" | "blocked";

const ON = "Notifications are on for this device.";
const IPHONE =
	"To get a notification on iPhone, add Tally to your Home Screen first: tap Share, then Add to Home Screen. Then open Tally from there and tap Notify me.";
const BLOCKED =
	"Notifications are blocked for Tally in this device's settings.";

/**
 * The control for one VAPID public key (`vapidKey`, base64url, the key the browser subscribes with). Each state is hidden unless
 * `shown` names it. The help line's id is notify-help in the app; a catalog drawing passes `idSuffix`, so each drawing's id is
 * its own and no button points at another drawing's line.
 */
export function NotifyControl({
	vapidKey,
	shown,
	idSuffix,
}: {
	vapidKey: string;
	shown?: NotifyShown;
	idSuffix?: string;
}) {
	const hidden = (state: NotifyShown) => shown !== state;
	const helpId = idSuffix ? `notify-help-${idSuffix}` : "notify-help";
	return (
		<div data-notify data-vapid-key={vapidKey}>
			<div class="mt-4" data-notify-state="off" hidden={hidden("off")}>
				<Button
					type="button"
					kind="secondary"
					class="w-full"
					busyLabel="Turning on…"
					data-notify-on
					aria-describedby={helpId}
				>
					Notify me on this device
				</Button>
				<p id={helpId} class="mt-2 text-sm text-muted">
					One notification when your questions are ready, if you've left Tally.
				</p>
			</div>
			<p
				data-notify-state="on"
				tabindex={-1}
				class="mt-4 flex min-h-11 items-center gap-2 text-muted"
				hidden={hidden("on")}
			>
				<Icon name="check" class="size-5" />
				{ON}
			</p>
			<p
				class="mt-4 text-sm text-muted"
				data-notify-state="iphone"
				hidden={hidden("iphone")}
			>
				{IPHONE}
			</p>
			<p
				class="mt-4 text-sm text-muted"
				data-notify-state="blocked"
				tabindex={-1}
				hidden={hidden("blocked")}
			>
				{BLOCKED}
			</p>
		</div>
	);
}

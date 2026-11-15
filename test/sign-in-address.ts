// Removes a sign-in address the way the settings screen does: through its rule and its save (the live path), with the
// time passed in. Tests use this instead of writing the member's rows by hand.
import * as Effect from "effect/Effect";
import { runWith } from "../src/db/database";
import {
	addressFacts,
	decideSetting,
	removeAddressStatements,
} from "../src/db/settings-saves";
import { removeSignInAddress } from "../src/rules/settings";

/**
 * Marks the address removed at `nowMs` and drops its devices' push subscriptions, in one batch. False when the address is
 * not one of the household's; nothing is written then.
 */
export const removeAddressOn = (db: D1Database, email: string, nowMs: number) =>
	runWith(
		db,
		decideSetting(
			removeSignInAddress,
			{ email, now: nowMs },
			(d) => addressFacts(d, email),
			removeAddressStatements,
		).pipe(
			Effect.as(true),
			Effect.catchTag("AddressNotFound", () => Effect.succeed(false)),
		),
	);

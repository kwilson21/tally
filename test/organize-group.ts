import * as Effect from "effect/Effect";
import { householdToday } from "../src/dates";
import { runWith } from "../src/db/database";
import { fileGroup } from "../src/rules/organize";
import { decideFileGroup } from "../src/transactions/organize";

/**
 * Files a store's charges the way Organize's Save does: the request is the one POST /transactions/organize builds
 * (its keys deduplicated, its group's name, its category, the typed name or none, and the person), and the save is
 * decideFileGroup run on the live path. A refusal (the group already filed, a category not in the list, a name
 * taken) files nothing and answers no ids. Returns the ids of the charges it filed.
 */
export async function fileOrganizeGroup(
	db: D1Database,
	merchantKeys: string[],
	categoryId: number,
	displayName: string | null,
	groupName: string,
	who: string,
): Promise<number[]> {
	const today = await householdToday(db);

	return runWith(
		db,
		decideFileGroup(
			fileGroup,
			{
				merchantKeys: [...new Set(merchantKeys)],
				groupName,
				target: { categoryId },
				displayName: displayName ?? "",
				who,
			},
			today,
		).pipe(
			Effect.map((saved) => saved.filed),
			Effect.catch(() => Effect.succeed<number[]>([])),
		),
	);
}

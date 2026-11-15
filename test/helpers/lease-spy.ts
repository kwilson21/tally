// A D1 stand-in for the sync's bank lease (#1164): it records the take and the release statements the sync prepares, with
// the values each is bound with, and can make the release statement fail alone or every batch fail. Every other statement
// is the real one, so a run's writes are the real writes. The lease's SQL text comes from the same builders the sync uses.

import { releaseLeaseSql, takeLeaseSql } from "../../src/machines/plaid-lease";
import { forwardMember } from "./present";

export type LeaseCall = {
	kind: "take" | "release";
	/** The values the statement was bound with, in bind order: the take binds (lock, item), the release (item, lock). */
	binds: (string | number)[];
};

export type LeaseSpyOptions = {
	/** Thrown by the release statement's run, and by nothing else. */
	failRelease?: Error;
	/** Thrown by every D1 batch, which is how the sync saves a page. */
	failBatch?: Error;
};

export type LeaseSpy = {
	db: D1Database;
	calls: LeaseCall[];
};

const TAKE = takeLeaseSql("?", "?");
const RELEASE = releaseLeaseSql("?", "?");

/** A D1 whose lease statements are recorded, and whose release or batches fail as the options say. */
export function leaseSpy(base: D1Database, options: LeaseSpyOptions): LeaseSpy {
	const calls: LeaseCall[] = [];

	const db = new Proxy(base, {
		get(target, prop) {
			if (prop === "prepare") {
				return (sql: string) => {
					const statement = target.prepare(sql);

					const kind =
						sql === TAKE ? "take" : sql === RELEASE ? "release" : null;

					if (kind === null) return statement;

					return new Proxy(statement, {
						get(stmt, member) {
							if (member !== "bind") return forwardMember(stmt, member);

							return (...binds: (string | number)[]) => {
								calls.push({ kind, binds });
								const bound = stmt.bind(...binds);

								return new Proxy(bound, {
									get(boundStatement, runMember) {
										if (runMember !== "run")
											return forwardMember(boundStatement, runMember);

										return async () => {
											if (kind === "release" && options.failRelease)
												throw options.failRelease;

											return boundStatement.run();
										};
									},
								});
							};
						},
					});
				};
			}

			if (prop === "batch" && options.failBatch) {
				const failure = options.failBatch;

				return () => Promise.reject(failure);
			}

			return forwardMember(target, prop);
		},
	});

	return { db, calls };
}

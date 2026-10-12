/**
 * A transaction's own name (spec §5, decision 79, decision 101): a name a person gave this one transaction,
 * shown in place of its merchant's name. A split's parts show their purchase's own name, unless the part has
 * one of its own, so the subquery reads the parent only for a part. `alias` is the transactions table's name
 * or alias in the query ("t" in most).
 */
export function ownNameSql(alias: string): string {
	return `COALESCE(${alias}.own_name, (SELECT o.own_name FROM transactions o WHERE o.id = ${alias}.parent_id))`;
}

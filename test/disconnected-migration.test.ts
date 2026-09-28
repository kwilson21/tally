import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import migration from "../migrations/0010_disconnected_status.sql?raw";

it("adds the disconnect marker without rebuilding a referenced populated table", async () => {
	const item = await env.DB.prepare(
		"INSERT INTO plaid_items (access_token_encrypted, institution_name, linked_by) VALUES (X'00', 'Migration Bank', 'person') RETURNING id",
	).first<{ id: number }>();
	await env.DB.prepare(
		"INSERT INTO accounts (plaid_item_id, plaid_account_id, name, type, is_liability) VALUES (?, 'migration-account', 'Checking', 'depository', 0)",
	)
		.bind(item?.id)
		.run();
	expect(
		await env.DB.prepare("SELECT disconnected_at FROM plaid_items WHERE id = ?")
			.bind(item?.id)
			.first(),
	).toEqual({ disconnected_at: null });
	expect(migration).toContain(
		"ALTER TABLE plaid_items ADD COLUMN disconnected_at TEXT",
	);
	expect(migration).not.toContain("DROP TABLE");
});

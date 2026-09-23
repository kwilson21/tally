import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest(async () => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				// Test-only binding so test/apply-migrations.ts can build the schema.
				bindings: {
					TEST_MIGRATIONS: await readD1Migrations(
						path.join(import.meta.dirname, "migrations"),
					),
				},
			},
		})),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
	},
});

import path from "node:path";
import { defineConfig } from "vitest/config";

// No Worker, D1 or migrations: app middleware runs against synthetic bindings. The app's entry module imports
// `cloudflare:workers` (its Workflow class), which only the Worker runtime provides, so it's stubbed here.
export default defineConfig({
	resolve: {
		alias: {
			"cloudflare:workers": path.join(
				import.meta.dirname,
				"verification/workers-stub.ts",
			),
		},
	},
	test: {
		include: [
			"verification/feedback-integration.test.ts",
			"verification/feedback-privacy.test.ts",
			"verification/feedback-diagnostics.test.ts",
		],
	},
});

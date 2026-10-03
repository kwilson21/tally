import { defineConfig } from "vitest/config";

// No Worker, D1 or migrations: app middleware runs against synthetic bindings.
export default defineConfig({
	test: {
		include: [
			"verification/feedback-integration.test.ts",
			"verification/feedback-privacy.test.ts",
			"verification/feedback-diagnostics.test.ts",
		],
	},
});

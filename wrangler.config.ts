import { defineWranglerConfig } from "wrangler/experimental-config";

// How Wrangler builds the Worker that cloudflare.config.ts describes (decision 205). The same in every mode.
export default defineWranglerConfig({
	// Runs before `cf dev`, `cf build` and `cf deploy`, so generated CSS and htmx always ship.
	// Watch only src/: the build writes into public/, which would otherwise retrigger itself.
	build: {
		command: "pnpm run build",
		watchDir: "src",
	},
	assetsDirectory: "./public/",
	// Types come from `cf workers types` (pnpm run cf-typegen), not from Wrangler.
	types: { generate: false },
});

// Types the `exports` import from `cloudflare:workers` (used in tests as
// `exports.default.fetch(...)`) against this Worker's actual entry point.
// Not covered by `cf workers types`; see Cloudflare.GlobalProps in
// .cloudflare/types/index.d.ts for why this augmentation is needed.
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("../src/index");
	}

	// `cloudflare:test`'s `env` (and `cloudflare:workers`'s) are both typed as `Cloudflare.Env`,
	// so this is how test/apply-migrations.ts sees TEST_MIGRATIONS.
	interface Env {
		TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
	}
}

// Vite's `?raw` suffix imports a file as a string (test/compare-names.test.ts reads the generated types).
declare module "*?raw" {
	const text: string;
	export default text;
}

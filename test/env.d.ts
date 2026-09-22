// Types the `exports` import from `cloudflare:workers` (used in tests as
// `exports.default.fetch(...)`) against this Worker's actual entry point.
// Not covered by `wrangler types`; see Cloudflare.GlobalProps in
// worker-configuration.d.ts for why this augmentation is needed.
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("../src/index");
	}
}

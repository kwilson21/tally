import { defineConfig } from "oxlint";

export default defineConfig({
	plugins: ["oxc"],
	categories: { correctness: "off" },
	ignorePatterns: [
		".claude/**",
		".wrangler/**",
		"public/vendor/**",
		"public/assets/**",
		"worker-configuration.d.ts",
		"tools/oxlint/anti-slop/**",
	],
	jsPlugins: [
		{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
		{
			name: "anti-slop-effect",
			specifier: "./tools/oxlint/anti-slop/effect/index.ts",
		},
	],
	rules: {
		"oxc/no-accumulating-spread": "error",
		"anti-slop/no-array-filter-map": "error",
		"anti-slop/no-reduce-accumulator-copy": "error",
		"anti-slop/no-chained-type-assertions": "error",
		"anti-slop/no-conditional-empty-object-spread": "error",
		"anti-slop/no-known-value-widening": "error",
		"anti-slop/no-module-mocking": "error",
		"anti-slop/no-object-parameters": "error",
		"anti-slop/no-reflect-apply": "error",
		"anti-slop/no-reflect-get": "error",
		"anti-slop/no-runtime-typeof": ["error", { allowInTypeGuards: true }],
		"anti-slop/no-shape-in-symbol-names": "error",
		"anti-slop/no-unknown-parameters": "error",
		"anti-slop/no-unknown-returns": "error",
		"anti-slop/no-unknown-type-aliases": "error",
		"anti-slop/no-unsafe-dictionary-type": "error",
		"anti-slop/no-widen-then-assert": "error",
		"anti-slop/require-readable-spacing": "error",
		"anti-slop/require-safety-comment-for-type-assertion": "error",
		"anti-slop-effect/no-manual-effect-error-tag": "error",
		"anti-slop-effect/no-manual-tag-comparison": "error",
		"anti-slop-effect/no-manual-tagged-construction": "error",
	},
	overrides: [
		{
			// Two of the Effect rules read any code as if it were Effect code: one takes every imported make… function for an
			// Effect service constructor, and one wants Effect's Match for every chained ternary. Effect style is for the write
			// handlers' rules and saves only (decision 204), so those two apply to the files written in it.
			files: ["src/rules/**", "src/db/*-saves.ts", "src/db/database.ts"],
			rules: {
				"anti-slop-effect/no-service-constructor-imports": "error",
				"anti-slop-effect/prefer-effect-match": "error",
			},
		},
		{
			// The feedback form's Node suite stands in for Cloudflare Access by mocking src/access; giving identity a
			// second way in just for this suite would be a change to how Tally reads who is signed in.
			files: ["verification/**"],
			rules: { "anti-slop/no-module-mocking": "off" },
		},
		{
			// Plain JavaScript has no type predicates, so a typeof check is the only way it can tell what it was given.
			files: ["public/**/*.js", "scripts/**/*.mjs"],
			rules: { "anti-slop/no-runtime-typeof": "off" },
		},
		{
			// These are the feedback form's own sanitizers: they are the parse at the boundary, so they take anything.
			files: ["public/js/feedback-privacy.d.ts"],
			rules: { "anti-slop/no-unknown-parameters": "off" },
		},
	],
});

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
	},
	overrides: [
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

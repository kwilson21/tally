import { describe, expect, it } from "vitest";

const sourceFiles = import.meta.glob(
	["../src/views/**/*.tsx", "../src/routes/**/*.tsx"],
	{
		query: "?raw",
		import: "default",
		eager: true,
	},
) as Record<string, string>;

const classTemplate = /class(?:Name)?=\{(`(?:\\.|[^`])*`)\}/gs;
const joinedClassAndInterpolation = /[\w\]):-]\$\{/;

describe("Tailwind class templates", () => {
	it("separates class names from interpolations so Tailwind can scan them", () => {
		const invalidTemplates = Object.entries(sourceFiles).flatMap(
			([path, source]) =>
				[...source.matchAll(classTemplate)]
					.map((match) => match[1] ?? "")
					.filter((template) => joinedClassAndInterpolation.test(template))
					.map((template) => `${path}: ${template}`),
		);

		expect(invalidTemplates).toEqual([]);
	});
});

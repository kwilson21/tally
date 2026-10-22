import { describe, expect, it } from "vitest";
import manifestText from "../public/manifest.webmanifest?raw";
import { Layout } from "../src/views/layout";

// Tally on an iPhone's Home Screen (decision 149): a web app manifest, and an apple-touch-icon, so Home Screen opens Tally in
// its own window (iOS needs display standalone or fullscreen). The manifest is read as its text, not through the Worker: behind
// Cloudflare Access the Worker answers its sign-in page (403), so its fields are checked here. The link carries
// crossorigin="use-credentials", since the manifest is fetched with the Access cookies: MDN's "Web application manifest",
// section "Deploying a manifest", requires it even for a same-origin manifest.

const PAPER = "#fbf8f2";

const manifest = JSON.parse(manifestText) as {
	name: string;
	short_name: string;
	start_url: string;
	display: string;
	background_color: string;
	theme_color: string;
	icons: { src: string; sizes: string; type: string; purpose: string }[];
};

describe("the web app manifest", () => {
	it("names Tally, starts at the root, and opens standalone", () => {
		expect(manifest.name).toBe("Tally");
		expect(manifest.short_name).toBe("Tally");
		expect(manifest.start_url).toBe("/");
		expect(manifest.display).toBe("standalone");
	});

	it("uses the paper colour for the background and the theme", () => {
		expect(manifest.background_color).toBe(PAPER);
		expect(manifest.theme_color).toBe(PAPER);
	});

	it("has 192 and 512 icons, both PNG, for any purpose", () => {
		const icon = (size: string) =>
			manifest.icons.find((item) => item.sizes === size);
		expect(icon("192x192")).toMatchObject({
			src: "/icons/icon-192.png",
			type: "image/png",
			purpose: "any",
		});
		expect(icon("512x512")).toMatchObject({
			src: "/icons/icon-512.png",
			type: "image/png",
			purpose: "any",
		});
	});
});

describe("the head of every page", () => {
	const head = String(Layout({ demo: false, children: "" }));

	it("links the manifest with credentials, so Access's cookies come with the fetch", () => {
		expect(head).toMatch(
			/<link[^>]*rel="manifest"[^>]*href="\/manifest\.webmanifest"[^>]*crossorigin="use-credentials"[^>]*>|<link[^>]*rel="manifest"[^>]*crossorigin="use-credentials"[^>]*href="\/manifest\.webmanifest"[^>]*>/,
		);
	});

	it("links the apple-touch-icon beside the favicon", () => {
		expect(head).toMatch(
			/<link[^>]*rel="apple-touch-icon"[^>]*href="\/icons\/apple-touch-icon\.png"[^>]*>/,
		);
		expect(head).toContain('rel="icon" href="/favicon.svg"');
	});
});

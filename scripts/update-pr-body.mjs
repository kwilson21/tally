// Writes the screenshot table into the PR description.
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, DIR, SHA (GITHUB_API_URL is set by Actions).
import { PAGES, VIEWPORTS, withScreenshots } from "./pr-body.mjs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, DIR, SHA } = process.env;
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const url = `${API}/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`;
const headers = {
	Authorization: `Bearer ${GITHUB_TOKEN}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
};
const raw = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/screenshots/${DIR}`;
const img = (page, viewport, width) =>
	`<img src="${raw}/${page.name}-${viewport.name}.png" width="${width}" alt="${page.name}, ${viewport.name}">`;

const [desktop, phone] = VIEWPORTS;
const section = [
	"<!-- screenshots:start -->",
	"## Screenshots",
	`_Taken by CI at ${SHA.slice(0, 7)} on the seeded demo data. Desktop ${desktop.width}×${desktop.height}, phone ${phone.width}×${phone.height}._`,
	"",
	"| Page | Desktop | Phone |",
	"|---|---|---|",
	...PAGES.map(
		(p) =>
			`| \`${p.path}\` | ${img(p, desktop, 480)} | ${img(p, phone, 180)} |`,
	),
	"<!-- screenshots:end -->",
].join("\n");

const current = await fetch(url, { headers });
if (!current.ok) throw new Error(`GET PR failed: ${current.status}`);
const { body } = await current.json();

const updated = await fetch(url, {
	method: "PATCH",
	headers,
	body: JSON.stringify({ body: withScreenshots(body, section) }),
});
if (!updated.ok) throw new Error(`PATCH PR failed: ${updated.status}`);
console.log("PR description updated.");

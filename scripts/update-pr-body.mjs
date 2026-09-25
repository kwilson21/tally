// Writes the before-and-after and screenshot tables into the PR description.
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, DIR, SHA (GITHUB_API_URL is set by Actions).
import { readFile } from "node:fs/promises";
import { screenshotSection, withScreenshots } from "./pr-body.mjs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, DIR, SHA } = process.env;
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const url = `${API}/repos/${GITHUB_REPOSITORY}/pulls/${PR_NUMBER}`;
const headers = {
	Authorization: `Bearer ${GITHUB_TOKEN}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
};
const raw = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/screenshots/${DIR}`;
// Written by scripts/changed-shots.mjs.
const changes = JSON.parse(await readFile("screenshots/changes.json", "utf8"));
const section = screenshotSection({ sha: SHA, raw, changes });

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

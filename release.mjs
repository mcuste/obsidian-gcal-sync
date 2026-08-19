// Cuts a release: bumps the version, promotes the changelog's Unreleased section, commits, and tags.
// Run through `pnpm release <x.y.z>`, which stops there, or with --push to also push and so trigger
// the release workflow. --dry-run reports what would happen and changes nothing.
//
// Obsidian installs the release whose tag equals manifest.json exactly, so the tag carries no `v`
// prefix, and `pnpm version` is called with --no-git-tag-version because it would tag `v0.1.1`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

const CHANGELOG = "CHANGELOG.md";
const UNRELEASED = "## [Unreleased]";
const BRANCH = "main";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const loud = (command, args) => execFileSync(command, args, { stdio: "inherit" });

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function isNewer(version, current) {
  const [next, previous] = [version, current].map((value) => value.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) {
    if (next[index] !== previous[index]) return next[index] > previous[index];
  }
  return false;
}

/** "released" once a GitHub release exists, "unreleased" when the tag never produced one. */
function tagState(version) {
  try {
    execFileSync("gh", ["release", "view", version, "--json", "tagName"], { stdio: "pipe" });
    return "released";
  } catch (error) {
    const output = `${error.stderr ?? ""}${error.stdout ?? ""}`;
    if (output.includes("release not found")) return "unreleased";
    // Anything else, gh missing included, leaves the tag's status unknown.
    return "unknown";
  }
}

/**
 * A tag left by a failed release is debris, so it is reclaimed. A tag someone already released from
 * is not: users hold that version, and Obsidian caches by version, so it has to stay immutable.
 *
 * The remote tag is only removed when this run intends to push, so a local run leaves origin alone.
 */
function clearFailedTag(version, push) {
  const state = tagState(version);
  if (state === "released") {
    fail(`${version} is already released; releases are immutable, so pick a later version`);
  }
  if (state === "unknown") {
    fail(
      `tag ${version} exists and its release status could not be read. Check it on GitHub, then:\n` +
        `  git tag -d ${version} && git push origin :refs/tags/${version}`,
    );
  }

  console.log(`release: reclaiming tag ${version}, which exists but was never released`);
  if (git("tag", "--list", version) !== "") git("tag", "-d", version);
  if (git("ls-remote", "--tags", "origin", version) === "") return;
  if (push) git("push", "origin", `:refs/tags/${version}`);
  else console.log(`release: origin still has tag ${version}; --push reclaims it too`);
}

function unreleasedSection() {
  const text = readFileSync(CHANGELOG, "utf8");
  const start = text.indexOf(`${UNRELEASED}\n`);
  if (start === -1) fail(`${CHANGELOG} has no "${UNRELEASED}" section to release`);
  const bodyStart = start + UNRELEASED.length;
  const end = text.indexOf("\n## [", bodyStart);
  return { text, start, bodyStart, body: text.slice(bodyStart, end === -1 ? undefined : end) };
}

/** Renames the Unreleased heading to the new version and opens an empty one above it. */
function promoteChangelog(version, date) {
  const { text, start, bodyStart, body } = unreleasedSection();
  if (body.trim() === "") fail(`the "${UNRELEASED}" section is empty; describe the release first`);
  writeFileSync(
    CHANGELOG,
    `${text.slice(0, start)}${UNRELEASED}\n\n## [${version}] - ${date}${text.slice(bodyStart)}`,
  );
}

const version = process.argv[2];
const push = process.argv.includes("--push");
const dryRun = process.argv.includes("--dry-run");
if (!version || version.startsWith("-")) {
  fail("usage: pnpm release <x.y.z> [--push] [--dry-run]");
}
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`expected a version like 0.1.1, got "${version}"`);

const current = JSON.parse(readFileSync("package.json", "utf8")).version;
const date = new Date().toISOString().slice(0, 10);

// Everything below assumes a clean checkout of the release branch, so that the tag names a commit
// that CI has a chance of reproducing.
if (git("rev-parse", "--abbrev-ref", "HEAD") !== BRANCH) fail(`not on ${BRANCH}`);
if (git("status", "--porcelain") !== "") fail("working tree is dirty; commit or stash first");
git("fetch", "--tags", "origin", BRANCH);

const pushRelease = () => {
  loud("git", ["push", "origin", BRANCH]);
  loud("git", ["push", "origin", version]);
  console.log(`\nreleased ${version}; the workflow publishes it from the changelog section`);
};

// A previous run without --push left the commit and tag ready, so this run only has to push them.
const prepared =
  current === version &&
  git("tag", "--list", version) !== "" &&
  git("rev-parse", `${version}^{commit}`) === git("rev-parse", "HEAD");

if (prepared) {
  if (dryRun) {
    console.log(`${version} is committed and tagged already`);
    console.log(push ? "would push it" : "would do nothing; pass --push to publish it");
    process.exit(0);
  }
  if (!push) fail(`${version} is committed and tagged already; run with --push to publish it`);
  pushRelease();
  process.exit(0);
}

if (!isNewer(version, current)) fail(`${version} is not higher than the current ${current}`);
if (git("rev-parse", "HEAD") !== git("rev-parse", `origin/${BRANCH}`)) {
  fail(`${BRANCH} and origin/${BRANCH} differ; pull or push first`);
}
const tagged =
  git("tag", "--list", version) !== "" || git("ls-remote", "--tags", "origin", version) !== "";

if (dryRun) {
  const { body } = unreleasedSection();
  console.log(`${current} -> ${version}, tag ${version}, dated ${date}`);
  console.log(push ? "would commit, tag, and push" : "would commit and tag, without pushing");
  if (tagged) console.log(`tag ${version} already exists and is ${tagState(version)}`);
  console.log(`\n${body.trim() || "(nothing under Unreleased yet)"}`);
  process.exit(0);
}

if (tagged) clearFailedTag(version, push);

// Checked before anything is written, so a failure leaves the tree untouched.
loud("pnpm", ["check"]);

// Also rewrites manifest.json and versions.json, through the version lifecycle script.
loud("pnpm", ["version", version, "--no-git-tag-version"]);
promoteChangelog(version, date);

loud("git", ["add", "package.json", "manifest.json", "versions.json", CHANGELOG]);
loud("git", ["commit", "-m", `chore: release ${version}`]);
loud("git", ["tag", version]);

if (!push) {
  console.log(
    `\ncommitted and tagged ${version}. To publish it:\n  pnpm release ${version} --push`,
  );
  process.exit(0);
}

pushRelease();

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exportReason, messageErrors, verbs } from "./check-git.mjs";

const script = fileURLToPath(new URL("./check-git.mjs", import.meta.url));
const synthetic = JSON.stringify({ schema_version: 1, items: [], events: [], extras: [], settings: {} });

test("documented imperative verbs, length boundaries and message spacing", () => {
  for (const verb of verbs) assert.deepEqual(messageErrors(`${verb} a focused change\n\nExplain why.\n`), []);
  assert.deepEqual(messageErrors(`Fix ${"x".repeat(46)}\n\n${"x".repeat(72)}`), []);
  assert.ok(messageErrors(`Fix ${"x".repeat(47)}`).some(e => e.includes("50")));
  assert.ok(messageErrors(`Fix a change\n\n${"x".repeat(73)}`).some(e => e.includes("72")));
  assert.ok(messageErrors("Fix a change\nMissing separator").some(e => e.includes("blank")));
  assert.ok(messageErrors("fixed a change").length);
  assert.deepEqual(messageErrors("Merge branch with generated long integration details", true), []);
});

test("routine, dated, legacy and duplicated download filenames are blocked case-insensitively", () => {
  for (const path of ["ambry-inventory.json", "AMBry-Inventory.JSON", "folder/ambry-inventory(1).json", "ambry-inventory (2).json", "ambry-inventory-2026-10-26.json", "ambry-backup-2026-10-26-1230 (1).json"]) {
    assert.ok(exportReason(path, "{}"), path);
  }
});

test("content identifies renamed exports/snapshots without blanket fixture exemptions", () => {
  for (const path of ["pantry.txt", "data.json", "src/store/fixtures/unreviewed.txt"]) assert.ok(exportReason(path, synthetic), path);
  assert.ok(exportReason("copy.txt", '\uFEFF{"app":"ambry"}'));
  assert.equal(exportReason("seed/starter-pantry.json", synthetic), null);
  assert.equal(exportReason("package.json", '{"name":"ambry"}'), null);
  assert.equal(exportReason("notes.md", "Ordinary notes"), null);
});

// Isolated temporary repositories only: no commits or config changes in Ambry.
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "ambry-git-check-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Synthetic test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Synthetic test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  delete env.GITHUB_SHA;
  delete env.GITHUB_EVENT_PATH;
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (name, text) => { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text); };
  const commit = (message, name = "notes.md", text = "Synthetic notes\n") => {
    write(name, text); git("add", "--all");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const check = (args = [], extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: dir, env: { ...env, ...extra }, encoding: "utf8" });
  try {
    git("init", "--quiet", "--initial-branch=main");
    commit("Historical subject deliberately outside modern rules", "old.md", "Old trailing space \n");
    git("checkout", "--quiet", "-b", "feature");
    run({ dir, git, write, commit, check, env });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("initial branch has zero new commits; old released violations do not block it", () => fixture(({ check }) => {
  const result = check(); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /0 new commits/);
}));

test("valid new commit passes; subject and body violations fail without rewriting history", () => fixture(({ commit, check }) => {
  commit("Improve useful checks\n\nKeep feedback short.");
  assert.equal(check().status, 0);
  commit("Fix " + "x".repeat(47), "other.md");
  assert.notEqual(check().status, 0);
}));

test("patch whitespace fails even if a later branch commit removes it", () => fixture(({ commit, check }) => {
  commit("Add temporary notes", "new.md", "bad trailing space \n");
  commit("Fix temporary notes", "new.md", "clean\n");
  const result = check(); assert.notEqual(result.status, 0); assert.match(result.stderr, /Whitespace/);
  assert.doesNotMatch(result.stderr, /bad trailing space/);
}));

test("staged renamed export is blocked without printing its contents", () => fixture(({ git, write, check }) => {
  write("pantry.txt", synthetic); git("add", "pantry.txt");
  const result = check(); assert.notEqual(result.status, 0); assert.match(result.stderr, /pantry.txt/); assert.doesNotMatch(result.stderr, /schema_version/);
}));

test("export committed then removed remains blocked in new history", () => fixture(({ commit, git, check }) => {
  commit("Add synthetic copy", "pantry.txt", synthetic);
  git("rm", "pantry.txt"); git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Remove synthetic copy");
  assert.notEqual(check().status, 0);
}));

test("Git-generated merge messages and main's historical whitespace are excluded", () => fixture(({ git, commit, check }) => {
  commit("Improve branch notes");
  git("checkout", "--quiet", "main");
  commit("Old main message outside the approved verbs", "main-only.md", "Previously released space \n");
  git("checkout", "--quiet", "feature");
  git("-c", "commit.gpgsign=false", "merge", "--no-ff", "--no-edit", "main");
  const result = check(); assert.equal(result.status, 0, result.stderr);
}));

test("PR payload checks its real head rather than a synthetic merge checkout", () => fixture(({ dir, git, commit, write, check }) => {
  const base = git("rev-parse", "main");
  const head = commit("Fix the feature");
  write("event.json", JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head } } }));
  const result = check([], { GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_SHA: "not-a-commit" });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /1 new commits/);
}));

test("prospective message-file validation needs no new commit", () => fixture(({ dir, write, check }) => {
  write("message.txt", "Configure focused validation\n\nCatch errors before publishing.\n");
  assert.equal(check(["--message-file", join(dir, "message.txt")]).status, 0);
  write("message.txt", "Invalid subject");
  assert.notEqual(check(["--message-file", join(dir, "message.txt")]).status, 0);
}));

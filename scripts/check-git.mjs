/** Lightweight pre-merge checks. Node/Git only; never rewrites history.
 * Local: node scripts/check-git.mjs [--base origin/main] [--head HEAD]
 * Message only: node scripts/check-git.mjs --message-file /tmp/message.txt
 * CI reads PR base/head from GitHub's event file; branch pushes compare main.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const verbs = new Set([
  "Add", "Remove", "Update", "Refactor", "Fix", "Release", "Merge", "Document",
  "Preserve", "Keep", "Group", "Record", "Improve", "Verify", "Prevent", "Reject",
  "Allow", "Clarify", "Test", "Configure", "Enforce", "Track",
]);
// Deliberate synthetic data only. Add reviewed fixture paths individually;
// do not exempt arbitrary JSON or entire data/evidence directories.
const fixtures = new Set(["seed/starter-pantry.json"]);
const length = value => [...value].length;

export function messageErrors(message, generatedMerge = false) {
  if (generatedMerge) return [];
  const [subject = "", separator, ...body] = message.trimEnd().split(/\r?\n/);
  const errors = [];
  if (!subject || length(subject) > 50) errors.push("subject must contain 1–50 characters");
  if (!verbs.has(subject.split(" ")[0])) errors.push(`start with an accepted imperative verb: ${[...verbs].join(", ")}`);
  if (separator !== undefined && separator !== "") errors.push("separate subject and body with a blank line");
  if (body.some(line => length(line) > 72)) errors.push("wrap body lines to 72 characters");
  return errors;
}

export function exportReason(path, text) {
  if (/^ambry-(?:inventory(?:[- ].*)?|backup-.*)(?:\s*\(\d+\))?\.json$/i.test(basename(path))) {
    return "inventory/backup export filename (including duplicate downloads)";
  }
  if (fixtures.has(path)) return null;
  let doc;
  try { doc = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
  if (doc && typeof doc === "object" && (
    doc.app === "ambry" ||
    ("schema_version" in doc && Array.isArray(doc.items) && Array.isArray(doc.events))
  )) return "Ambry inventory document/export contents";
  return null;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function commit(ref) {
  return git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
}
function mainRef() {
  for (const ref of ["origin/main", "main"]) {
    try { return commit(ref); } catch { /* try the local main branch */ }
  }
  throw Error("Cannot find main; fetch it or pass --base <commit>.");
}
const entries = value => value.split("\0").filter(Boolean);

export function checkRepository(base, head) {
  const failures = [];
  const commits = git("rev-list", "--reverse", `${base}..${head}`).trim().split("\n").filter(Boolean);
  const checkPatch = args => {
    try { git("-c", "core.whitespace=blank-at-eol,blank-at-eof,space-before-tab", "diff", "--check", ...args); }
    catch (error) {
      // Git also prints offending lines; don't echo possible personal content.
      const locations = String(error.stdout || "").split("\n").filter(line => line && !line.startsWith("+"));
      failures.push(`Whitespace errors:\n${locations.join("\n") || "Run git diff --check locally."}`);
    }
  };
  checkPatch([`${base}...${head}`]);
  checkPatch([]);
  checkPatch(["--cached"]);
  const checked = new Set();
  const checkFile = (path, source, read) => {
    if (checked.has(`${source}:${path}`)) return;
    checked.add(`${source}:${path}`);
    const reason = exportReason(path, read());
    if (reason) failures.push(`${source}: ${path}: ${reason}. Keep personal data outside Git.`);
  };
  for (const sha of commits) {
    const message = git("show", "-s", "--format=%B", sha);
    const parents = git("show", "-s", "--format=%P", sha).trim().split(" ").filter(Boolean);
    // Git's generated merge subjects/bodies describe integration, not a hand-
    // written change. Custom merge messages still follow the normal limits.
    const generated = parents.length > 1 && /^Merge (?:branch|branches|remote-tracking branch|pull request|commit|tag)\b/.test(message);
    failures.push(...messageErrors(message, generated).map(error => `${sha.slice(0, 8)}: ${error}`));
    // Net branch whitespace is checked above; skip merge patches so merging
    // already-released main commits doesn't re-lint their historical lines.
    if (parents.length === 1) checkPatch([parents[0], sha]);
    // Also catch a personal file added and then removed in this branch: the
    // data would still be published in the new commits, not just the tip.
    for (const path of entries(git("diff-tree", "--root", "-r", "-m", "--no-commit-id", "--name-only", "--diff-filter=ACMRT", "-z", sha))) {
      checkFile(path, sha, () => git("show", `${sha}:${path}`));
    }
  }
  for (const path of entries(git("ls-tree", "-r", "--name-only", "-z", head))) {
    checkFile(path, head, () => git("show", `${head}:${path}`));
  }
  for (const path of entries(git("ls-files", "-z"))) {
    checkFile(path, "index", () => git("show", `:${path}`));
    if (existsSync(path) && !lstatSync(path).isSymbolicLink()) checkFile(path, "working tree", () => readFileSync(path, "utf8"));
  }
  return { commits: commits.length, failures };
}

function run() {
  const options = {};
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (!["--base", "--head", "--message-file"].includes(flag) || !args.length) throw Error("Use --base <ref>, --head <ref>, or --message-file <path>.");
    options[flag] = args.shift();
  }
  if (options["--message-file"]) {
    const errors = messageErrors(readFileSync(options["--message-file"], "utf8"));
    if (errors.length) throw Error(errors.join("\n"));
    console.log("Commit message passes.");
    return;
  }
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
  const base = commit(options["--base"] ?? event.pull_request?.base.sha ?? mainRef());
  const head = commit(options["--head"] ?? event.pull_request?.head.sha ?? process.env.GITHUB_SHA ?? "HEAD");
  const result = checkRepository(base, head);
  if (result.failures.length) throw Error(result.failures.join("\n"));
  console.log(`Git checks pass (${result.commits} new commits; whitespace and export guard checked).`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

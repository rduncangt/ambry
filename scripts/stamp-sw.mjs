/**
 * Stamp dist/sw.js after `vite build` (wired into `npm run build`), zero deps.
 *
 * public/sw.js ships placeholders (SW_VERSION = "dev", PRECACHE = ["/"]) and
 * Vite copies it verbatim into dist/. This script rewrites both from the real
 * build output:
 *   - PRECACHE becomes "/", "/manifest.webmanifest", and every file under
 *     dist/icons/ and dist/assets/ as root-relative URLs — so the hashed
 *     JS/CSS the shell needs offline are precached WITH the HTML, atomically.
 *     Without this, a deploy's new HTML could reference assets the cache
 *     never held, white-screening the next offline standalone launch.
 *   - SW_VERSION becomes a short content hash over index.html + every other
 *     precached file — so any deploy that changes the app changes the bytes
 *     of dist/sw.js, which is what makes the browser install a new worker
 *     (the "Update ready" pill's whole trigger).
 * Fails the build loudly if a placeholder is missing rather than shipping an
 * unstamped worker.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist", import.meta.url));

// Root-relative URLs for every file directly under a dist subdirectory,
// sorted so the version hash is deterministic across filesystems.
const listDir = (sub) =>
  readdirSync(join(dist, sub), { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `/${sub}/${entry.name}`)
    .sort();

const precache = ["/", "/manifest.webmanifest", ...listDir("icons"), ...listDir("assets")];

// "/" is index.html on disk; hash it plus every other precached file.
const hash = createHash("sha256");
hash.update(readFileSync(join(dist, "index.html")));
for (const url of precache.slice(1)) hash.update(readFileSync(join(dist, url.slice(1))));
const version = hash.digest("hex").slice(0, 8);

const swPath = join(dist, "sw.js");
const source = readFileSync(swPath, "utf8");

const replaceOnce = (text, pattern, replacement, what) => {
  if (!pattern.test(text)) {
    console.error(`stamp-sw: ${what} not found in dist/sw.js — placeholder in public/sw.js changed?`);
    process.exit(1);
  }
  return text.replace(pattern, replacement);
};

let stamped = replaceOnce(
  source,
  /const SW_VERSION = "[^"]*";/,
  `const SW_VERSION = ${JSON.stringify(version)};`,
  "SW_VERSION declaration",
);
stamped = replaceOnce(
  stamped,
  /const PRECACHE = \[[^\]]*\];/,
  `const PRECACHE = ${JSON.stringify(precache)};`,
  "PRECACHE declaration",
);
// Audit trail: the stamped values, right where someone debugging will look.
stamped = `// stamped by scripts/stamp-sw.mjs — SW_VERSION=${version}, PRECACHE: ${precache.join(" ")}\n${stamped}`;

writeFileSync(swPath, stamped);
console.log(`stamp-sw: SW_VERSION=${version}, precached ${precache.length} URLs`);

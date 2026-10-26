import { build as bundle } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// A separate, self-contained document: never imports main.tsx or the store.
// The diagnostic uses the actual shared Sheet and modal manager, not copies.
export default function caretCheck() {
  return {
    name: "caret-check",
    async generateBundle() {
      const sources = ["src/diagnostics/caret-check.tsx", "src/ui/ModalView.tsx", "src/ui/modal.ts", "src/styles.css", "src/ui/views/item.css", "src/diagnostics/caret-check.html"];
      const identity = Object.fromEntries(sources.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
      identity.appVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
      const result = await bundle({
        entryPoints: [sources[0]], bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
        jsx: "automatic", jsxImportSource: "preact", minify: true, metafile: true,
        define: { __CARET_IDENTITY__: JSON.stringify(identity), "process.env.NODE_ENV": '"production"' },
      });
      const allowed = new Set(sources.slice(0, 3));
      for (const path of Object.keys(result.metafile.inputs)) {
        if (path !== "<define:__CARET_IDENTITY__>" && !path.startsWith("node_modules/") && !allowed.has(path)) throw new Error(`Unexpected caret check import: ${path}`);
      }
      const css = ["src/styles.css", "src/ui/views/item.css"].map(path => readFileSync(path, "utf8")).join("\n");
      const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
      const html = readFileSync("src/diagnostics/caret-check.html", "utf8")
        .replace("/* INLINE_APP_CSS */", () => css).replace("/* INLINE_CHECK_JS */", () => js);
      this.emitFile({ type: "asset", fileName: "caret-check.html", source: html });
    },
  };
}

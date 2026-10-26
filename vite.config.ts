/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import caretCheck from "./scripts/caret-check.mjs";

export default defineConfig({
  plugins: [preact(), caretCheck()],
  build: { target: "es2022" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

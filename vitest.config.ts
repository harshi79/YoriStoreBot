import { defineConfig } from "vitest/config";

/**
 * The Mini App is built with Vite's automatic JSX runtime, so tests that render
 * web components need the same transform. Everything else stays on vitest's
 * defaults.
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
});

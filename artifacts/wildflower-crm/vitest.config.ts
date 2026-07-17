import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  // Match the app's Vite JSX transform (automatic runtime) so components that
  // don't `import React` (the app default) also work under vitest.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

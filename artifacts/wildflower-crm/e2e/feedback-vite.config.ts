import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: path.resolve(import.meta.dirname, ".."),
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "../src"),
      "@clerk/react": path.resolve(
        import.meta.dirname,
        "fixtures/feedback-clerk.ts",
      ),
    },
    dedupe: ["react", "react-dom"],
  },
  server: { host: "127.0.0.1", port: 54122, strictPort: true },
});

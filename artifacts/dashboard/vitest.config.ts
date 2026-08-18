import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["dist/**", "node_modules/**"],
    environment: "node",
    environmentMatchGlobs: [
      // Component tests that use jsdom declare it per-file via @vitest-environment jsdom.
      // No global override needed here; the per-file docblock takes precedence.
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
});

import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import Icons from "unplugin-icons/vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [solid(), Icons({ compiler: "solid" })],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@shared": resolve(__dirname, "../src/shared"),
    },
    conditions: ["development", "browser"],
  },
  test: {
    environment: "jsdom",
    // Reuse workers and jsdom's import while keeping a fresh VM and DOM per file.
    pool: "vmThreads",
    maxWorkers: 2,
    globals: true,
    setupFiles: [resolve(__dirname, "./test/setup.ts")],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { resolve } from "node:path";
import {
  MANUAL_ATTACHMENT_DESCRIPTION_PATH_PATTERN,
  MANUAL_ATTACHMENT_DESCRIPTION_TIMEOUT_MS,
} from "../src/shared/attachments.ts";

const apiPort = process.env.TIMELINE_PORT ?? process.env.PORT ?? "3001";
const apiTarget = process.env.TIMELINE_API_TARGET ?? process.env.API_HOST ?? `http://localhost:${apiPort}`;

export default defineConfig({
  plugins: [
    solid(),
    tailwindcss(),
    Icons({ compiler: "solid" }),
    {
      name: "require-maptiler-key",
      apply: "build",
      configResolved(config) {
        if (!config.env.VITE_MAPTILER_API_KEY?.trim()) {
          throw new Error(
            "VITE_MAPTILER_API_KEY is required to build the web app. Set it in web/.env or the build environment.",
          );
        }
      },
    },
  ],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
      "@shared": resolve(import.meta.dirname, "../src/shared"),
    },
    dedupe: ["date-fns"],
  },
  optimizeDeps: {
    // Force pre-bundling of remark's CJS dependencies
    include: ["debug", "extend"],
  },
  server: {
    proxy: {
      [MANUAL_ATTACHMENT_DESCRIPTION_PATH_PATTERN]: {
        target: apiTarget,
        changeOrigin: true,
        timeout: MANUAL_ATTACHMENT_DESCRIPTION_TIMEOUT_MS,
        proxyTimeout: MANUAL_ATTACHMENT_DESCRIPTION_TIMEOUT_MS,
      },
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        timeout: 120000, // 2 minutes for AI summary generation
      },
      "/status": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});

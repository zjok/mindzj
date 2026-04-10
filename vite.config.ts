import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import UnoCSS from "unocss/vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [UnoCSS(), solidPlugin()],

  cacheDir: ".vite-cache",

  clearScreen: false,

  server: {
    port: 1430,
    strictPort: false,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1431 }
      : undefined,
    watch: {
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/target-codex-check*/**",
        "**/vault1/**",
        "**/.mindzj/**",
        "**/dist/**",
        "**/dist-electron/**",
        "**/.git/**",
      ],
    },
  },

  optimizeDeps: {
    entries: ["src/index.tsx", "src/App.tsx"],
    include: [
      "solid-js",
      "solid-js/web",
      "katex",
      "lucide-solid",
      "sortablejs",
      "@tauri-apps/api/core",
      "@tauri-apps/api/window",
      "@tauri-apps/api/event",
    ],
  },

  build: {
    target: "esnext",
    minify: "esbuild",
    sourcemap: true,
  },

  resolve: {
    alias: {
      "@": "/src",
    },
  },

  test: {
    environment: "node",
  },
}));

import { defineConfig, presetUno, presetIcons } from "unocss";

export default defineConfig({
  presets: [
    presetUno(),
    presetIcons({
      prefix: "i-",
      extraProperties: {
        display: "inline-block",
        "vertical-align": "middle",
      },
    }),
  ],
  theme: {
    colors: {
      surface: {
        0: "var(--mz-bg-primary)",
        1: "var(--mz-bg-secondary)",
        2: "var(--mz-bg-tertiary)",
      },
      text: {
        0: "var(--mz-text-primary)",
        1: "var(--mz-text-secondary)",
        2: "var(--mz-text-muted)",
      },
      accent: "var(--mz-accent)",
      border: "var(--mz-border)",
    },
  },
  shortcuts: {
    "mz-btn":
      "px-3 py-1.5 rounded-md bg-accent text-white cursor-pointer hover:opacity-90 transition-opacity",
    "mz-input":
      "px-2 py-1 rounded-md border border-border bg-surface-0 text-text-0 outline-none focus:border-accent",
    "mz-panel": "bg-surface-1 border-r border-border",
  },
});

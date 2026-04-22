/**
 * Built-in skin registry.
 *
 * Each entry corresponds to one CSS file under `src/styles/themes/` and
 * maps a stable ID (the value persisted in `settings.theme`) to the
 * palette's display metadata. The actual CSS rules live in the matching
 * `.css` file and are imported once by `src/index.tsx`, so loading is a
 * build-time concern and the runtime only has to toggle `data-theme`.
 *
 * Two special IDs are not in this array because their CSS lives in
 * `src/styles/variables.css` and their handling is special-cased in the
 * settings store:
 *   - "dark"   : the app's default (declared on `:root` + `[data-theme="dark"]`)
 *   - "light"  : the companion light palette (declared on `[data-theme="light"]`)
 *   - "system" : follow OS `prefers-color-scheme` and resolve to light/dark
 */

export type BuiltInSkinMode = "light" | "dark";

export interface BuiltInSkin {
  /** Stable ID persisted in settings.theme and used as the `data-theme` value. */
  id: string;
  /** English display name (fallback if i18n has no override). */
  label: string;
  /** Whether this is a light or dark skin — used to group/sort in the picker. */
  mode: BuiltInSkinMode;
  /** Two accent colors used to render the small swatch in the skin grid. */
  swatch: readonly [string, string];
}

/**
 * Full catalogue of preset skins. Every entry is also imported as a
 * `.css` file from `src/index.tsx` so the CSS custom properties are
 * available at runtime; this array just supplies the display metadata
 * (name, mode, swatch) to the picker UI.
 *
 * The list mixes light and dark presets — the picker groups them into
 * two sections at render time using the `mode` field (see
 * `SkinPickerPanel` in `SettingsModal.tsx`). Within each section the
 * order here is preserved, so the app's own "MindZJ" pair comes first.
 */
export const BUILT_IN_SKINS: readonly BuiltInSkin[] = [
  // --- Original app defaults -----------------------------------------------
  { id: "dark",             label: "MindZJ Dark",       mode: "dark",  swatch: ["#1e1e1e", "#1aad3f"] },
  { id: "light",            label: "MindZJ Light",      mode: "light", swatch: ["#ffffff", "#1aad3f"] },

  // --- GitHub --------------------------------------------------------------
  { id: "github-dark",      label: "GitHub Dark",       mode: "dark",  swatch: ["#0d1117", "#2f81f7"] },
  { id: "github-light",     label: "GitHub Light",      mode: "light", swatch: ["#ffffff", "#0969da"] },

  // --- Atom ----------------------------------------------------------------
  { id: "atom-dark",        label: "Atom Dark",         mode: "dark",  swatch: ["#1d1f21", "#81a2be"] },
  { id: "atom-light",       label: "Atom Light",        mode: "light", swatch: ["#fafafa", "#526fff"] },
  { id: "one-dark",         label: "One Dark (Atom)",   mode: "dark",  swatch: ["#282c34", "#61afef"] },
  { id: "one-light",        label: "One Light (Atom)",  mode: "light", swatch: ["#fafafa", "#4078f2"] },

  // --- Sublime -------------------------------------------------------------
  { id: "sublime-dark",     label: "Sublime Dark",      mode: "dark",  swatch: ["#222f3b", "#70c0e8"] },
  { id: "sublime-light",    label: "Sublime Light",     mode: "light", swatch: ["#ffffff", "#3478c6"] },
  { id: "monokai",          label: "Monokai (Sublime)", mode: "dark",  swatch: ["#272822", "#a6e22e"] },

  // --- Nord / Tokyo Night / Iceberg ---------------------------------------
  { id: "nord",             label: "Nord",              mode: "dark",  swatch: ["#2e3440", "#88c0d0"] },
  { id: "tokyo-night",      label: "Tokyo Night",       mode: "dark",  swatch: ["#1a1b26", "#7aa2f7"] },
  { id: "tokyo-night-light",label: "Tokyo Night Light", mode: "light", swatch: ["#d5d6db", "#34548a"] },
  { id: "iceberg",          label: "Iceberg",           mode: "dark",  swatch: ["#161821", "#84a5d8"] },

  // --- Warm-tone / eye-care palettes --------------------------------------
  { id: "gruvbox",          label: "Gruvbox Dark",      mode: "dark",  swatch: ["#282828", "#fe8019"] },
  { id: "gruvbox-light",    label: "Gruvbox Light",     mode: "light", swatch: ["#fbf1c7", "#af3a03"] },
  { id: "catppuccin",       label: "Catppuccin Mocha",  mode: "dark",  swatch: ["#1e1e2e", "#cba6f7"] },
  { id: "catppuccin-latte", label: "Catppuccin Latte",  mode: "light", swatch: ["#eff1f5", "#8839ef"] },
  { id: "rose-pine",        label: "Rosé Pine",         mode: "dark",  swatch: ["#191724", "#ebbcba"] },
  { id: "rose-pine-dawn",   label: "Rosé Pine Dawn",    mode: "light", swatch: ["#faf4ed", "#b4637a"] },
  { id: "everforest-dark",  label: "Everforest Dark",   mode: "dark",  swatch: ["#2d353b", "#a7c080"] },
  { id: "everforest-light", label: "Everforest Light",  mode: "light", swatch: ["#fdf6e3", "#8da101"] },
  { id: "kanagawa",         label: "Kanagawa",          mode: "dark",  swatch: ["#1f1f28", "#dca561"] },
  { id: "zenburn",          label: "Zenburn",           mode: "dark",  swatch: ["#3f3f3f", "#f0dfaf"] },
  { id: "papercolor-light", label: "PaperColor Light",  mode: "light", swatch: ["#eeeeee", "#005f87"] },

  // --- Solarized -----------------------------------------------------------
  { id: "solarized-light",  label: "Solarized Light",   mode: "light", swatch: ["#fdf6e3", "#268bd2"] },
  { id: "solarized-dark",   label: "Solarized Dark",    mode: "dark",  swatch: ["#002b36", "#268bd2"] },
];

export const BUILT_IN_SKIN_IDS: readonly string[] =
  BUILT_IN_SKINS.map((s) => s.id);

export function isBuiltInSkin(id: string): boolean {
  return BUILT_IN_SKIN_IDS.includes(id) || id === "system";
}

/**
 * Given a theme ID persisted in settings, decide which `data-theme`
 * attribute to apply to `<html>`. For "system" we resolve based on the
 * current OS preference; for custom IDs we keep a stable "custom"
 * sentinel so the base CSS falls back to its `:root` defaults while the
 * injected custom-skin stylesheet provides its own overrides.
 */
export function resolveDataTheme(id: string): string {
  if (id === "system") {
    const prefersDark = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }
  return id;
}

/** Prefix used to distinguish custom skin IDs (e.g. "custom:my-theme"). */
export const CUSTOM_SKIN_PREFIX = "custom:" as const;

export function isCustomSkin(id: string): id is `custom:${string}` {
  return id.startsWith(CUSTOM_SKIN_PREFIX);
}

export function customSkinName(id: string): string {
  return isCustomSkin(id) ? id.slice(CUSTOM_SKIN_PREFIX.length) : "";
}

/**
 * Best-effort classification of a skin ID as "light" or "dark". Used by
 * the StatusBar's moon/sun toggle icon so it picks the right glyph no
 * matter which preset the user is on.
 *
 * Rules:
 *   - "system" → resolve to the OS's current preference (same rule the
 *     settings store uses when setting data-theme).
 *   - Built-in preset → look up `mode` in `BUILT_IN_SKINS`.
 *   - Custom / unknown → default to "dark" (the app's original default),
 *     so we don't switch the glyph on every possible typo or deleted
 *     skin reference.
 */
export function skinMode(id: string): BuiltInSkinMode {
  if (id === "system") {
    const prefersDark = typeof window !== "undefined"
      && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    return prefersDark ? "dark" : "light";
  }
  const found = BUILT_IN_SKINS.find((s) => s.id === id);
  return found?.mode ?? "dark";
}

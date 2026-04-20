import { createSignal, createRoot, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_ATTACHMENT_FOLDER } from "../utils/vaultPaths";

export const DEFAULT_FONT_FAMILY =
  '"Inter", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Microsoft YaHei", "Noto Sans", Ubuntu, Cantarell, sans-serif';

// Manual-refresh tick for CSS snippets. Incremented by the UI whenever
// the user clicks "Refresh" on the snippets panel — forces the reactive
// effect in the settings store to re-fetch file contents from disk
// (e.g. after the user edited a snippet file externally).
const [snippetsReloadTick, bumpSnippetsReload] = createSignal(0);
export function reloadCssSnippets() {
  bumpSnippetsReload(snippetsReloadTick() + 1);
}

/**
 * Fetch the contents of the given snippet filenames from the Rust side
 * and inject the concatenated result into the single `<style
 * id="mz-user-css-snippets">` element. Silently drops snippets that
 * fail to read (e.g. user renamed the file while it was enabled).
 */
export async function applyCssSnippets(enabled: string[]) {
  let styleEl = document.getElementById("mz-user-css-snippets") as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "mz-user-css-snippets";
    document.head.appendChild(styleEl);
  }
  if (enabled.length === 0) {
    styleEl.textContent = "";
    return;
  }
  const parts: string[] = [];
  for (const name of enabled) {
    try {
      const code = await invoke<string>("read_css_snippet", { name });
      parts.push(`/* ${name} */\n${code}`);
    } catch (e) {
      console.warn(`[css-snippets] failed to read "${name}":`, e);
    }
  }
  styleEl.textContent = parts.join("\n\n");
}

export type Theme = "light" | "dark" | "system";
type PersistedTheme = Theme | "Light" | "Dark" | "System";

interface PersistedSettings extends Omit<Partial<AppSettings>, "theme"> {
  theme?: PersistedTheme | null;
}

export interface AppSettings {
  theme: Theme;
  font_size: number;
  font_family: string;
  show_markdown_toolbar: boolean;
  editor_line_numbers: boolean;
  editor_word_wrap: boolean;
  editor_vim_mode: boolean;
  editor_spell_check: boolean;
  editor_readable_line_length: boolean;
  auto_save_interval_ms: number;
  default_view_mode: string;
  locale: string;
  accent_color: string | null;
  // Per-element color overrides. When null, the theme's built-in
  // CSS variable is used; when set, it replaces the variable on
  // `document.documentElement` via a reactive effect further down.
  // Each one has a corresponding "reset" button in Settings →
  // Appearance that clears the override back to null.
  heading_color: string | null;
  link_color: string | null;
  highlight_color: string | null;
  /** Bold (**text**) text color. Feeds `--mz-syntax-bold` which
   *  source, live-preview, and reading mode all consume for their
   *  bold styling rules. `null` = theme default (red in dark,
   *  darker red in light). */
  bold_color: string | null;
  /** Text selection background color. Applied to both CM6
   *  `.cm-selectionBackground` and the generic `::selection`
   *  pseudo-element via the `--mz-bg-selection` CSS variable.
   *  `null` means "use the theme default" (rgba blue in dark,
   *  rgba blue-grey in light). */
  selection_color: string | null;
  /** File-tree drag indicator line color. Applied via the
   *  `--mz-drag-indicator` CSS variable. `null` means "use the
   *  theme accent color" (green by default). */
  drag_indicator_color: string | null;
  css_snippet: string | null;
  /**
   * List of enabled CSS snippet filenames from `.mindzj/snippets/`.
   * The actual snippet contents live as `.css` files in the vault —
   * this array just tracks which ones are currently applied. Obsidian
   * uses the same model (enabled snippets list in appearance.json).
   */
  enabled_css_snippets: string[];
  attachment_folder: string;
  auto_update_links: boolean;
  default_new_note_location: string;
  template_folder: string | null;
  ai_provider: any | null;
  /** Custom hotkey overrides: command -> key combo string (e.g. "Ctrl+Shift+L") */
  hotkey_overrides: Record<string, string>;

  // --- Image (Pixel Perfect) settings ---
  /** Comma-separated resize presets shown in context menu, e.g. "25%, 33%, 50%, 100%" or "200px, 400px" */
  image_resize_options: string;
  /** Ctrl+click behavior on images */
  image_ctrl_click: "open-in-new-tab" | "open-in-default-app" | "show-in-explorer";
  /** Enable Alt+mousewheel zoom on images */
  image_wheel_zoom: boolean;
  /** Modifier key for wheel zoom */
  image_wheel_modifier: "Alt" | "Ctrl" | "Shift";
  /** Percentage per scroll step for wheel zoom */
  image_wheel_zoom_step: number;
  /** Invert scroll direction for wheel zoom */
  image_wheel_invert: boolean;
}

interface HotkeyBinding {
  command: string;
  keys: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: "dark",
  font_size: 16,
  font_family: DEFAULT_FONT_FAMILY,
  show_markdown_toolbar: true,
  editor_line_numbers: false,
  editor_word_wrap: true,
  editor_vim_mode: false,
  editor_spell_check: false,
  editor_readable_line_length: true,
  auto_save_interval_ms: 2000,
  default_view_mode: "LivePreview",
  // Default UI language is English. Users can switch language from the
  // welcome screen (saved to localStorage under "mindzj-pending-locale")
  // or from Settings → Appearance once a vault is open.
  locale: "en",
  accent_color: "#1aad3f",
  heading_color: null,
  link_color: null,
  highlight_color: null,
  bold_color: null,
  selection_color: null,
  drag_indicator_color: null,
  css_snippet: null,
  enabled_css_snippets: [],
  attachment_folder: DEFAULT_ATTACHMENT_FOLDER,
  auto_update_links: true,
  default_new_note_location: "VaultRoot",
  template_folder: null,
  ai_provider: null,
  hotkey_overrides: {},

  // Image defaults
  image_resize_options: "25%, 33%, 50%, 100%",
  image_ctrl_click: "open-in-new-tab",
  image_wheel_zoom: true,
  image_wheel_modifier: "Alt",
  image_wheel_zoom_step: 20,
  image_wheel_invert: false,
};

function createDefaultSettings(): AppSettings {
  return { ...DEFAULT_SETTINGS, hotkey_overrides: { ...DEFAULT_SETTINGS.hotkey_overrides } };
}

function hotkeyOverridesToBindings(overrides: Record<string, string>): HotkeyBinding[] {
  return Object.entries(overrides)
    .filter(([, keys]) => typeof keys === "string" && keys.trim().length > 0)
    .map(([command, keys]) => ({ command, keys }));
}

function normalizeTheme(theme: PersistedTheme | null | undefined): Theme {
  if (typeof theme !== "string") return DEFAULT_SETTINGS.theme;
  switch (theme.toLowerCase()) {
    case "light":
      return "light";
    case "system":
      return "system";
    case "dark":
    default:
      return "dark";
  }
}

function serializeTheme(theme: Theme): "Light" | "Dark" | "System" {
  switch (theme) {
    case "light":
      return "Light";
    case "system":
      return "System";
    case "dark":
    default:
      return "Dark";
  }
}

function normalizeLoadedSettings(loaded?: PersistedSettings | null): AppSettings {
  const base = createDefaultSettings();
  return {
    ...base,
    ...(loaded ?? {}),
    theme: normalizeTheme(loaded?.theme),
    font_family:
      typeof loaded?.font_family === "string" && loaded.font_family.trim()
        ? loaded.font_family
        : base.font_family,
    enabled_css_snippets: Array.isArray(loaded?.enabled_css_snippets)
      ? loaded!.enabled_css_snippets
      : base.enabled_css_snippets,
    hotkey_overrides:
      loaded?.hotkey_overrides && typeof loaded.hotkey_overrides === "object"
        ? { ...base.hotkey_overrides, ...loaded.hotkey_overrides }
        : { ...base.hotkey_overrides },
  };
}

function serializeSettingsForBackend(settings: AppSettings) {
  return {
    ...settings,
    theme: serializeTheme(settings.theme),
  };
}

function createSettingsStore() {
  const [settings, setSettings] = createSignal<AppSettings>(createDefaultSettings());

  // Apply theme to DOM
  createEffect(() => {
    const theme = settings().theme;
    if (theme === "system") {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  });

  // Apply accent color to DOM
  createEffect(() => {
    const color = settings().accent_color;
    if (color) {
      document.documentElement.style.setProperty("--mz-accent", color);
    } else {
      document.documentElement.style.removeProperty("--mz-accent");
    }
  });

  // Apply per-element color overrides (heading / link / highlight)
  // to the DOM via CSS custom properties. When a setting is null,
  // the variable is removed so the theme's default shines through.
  //
  // Highlight is trickier: the base theme uses an rgba() for the
  // highlight background (so the colored block is translucent over
  // the page background). We can't trivially convert a #RRGGBB hex
  // override into rgba, so we just set the value verbatim — the user
  // picks the color they want and gets that color at full opacity.
  // That's the behaviour most users expect from a "highlight color"
  // picker anyway.
  createEffect(() => {
    const color = settings().heading_color;
    if (color) {
      document.documentElement.style.setProperty("--mz-syntax-heading", color);
    } else {
      document.documentElement.style.removeProperty("--mz-syntax-heading");
    }
  });
  createEffect(() => {
    const color = settings().link_color;
    if (color) {
      document.documentElement.style.setProperty("--mz-syntax-link", color);
    } else {
      document.documentElement.style.removeProperty("--mz-syntax-link");
    }
  });
  createEffect(() => {
    const color = settings().highlight_color;
    if (color) {
      document.documentElement.style.setProperty("--mz-syntax-highlight-bg", color);
    } else {
      document.documentElement.style.removeProperty("--mz-syntax-highlight-bg");
    }
  });
  createEffect(() => {
    // Bold color override. Source (`.cm-strong`), live-preview
    // (`.mz-lp-bold`), and reading (`.mz-reading-view strong`) all
    // read from `--mz-syntax-bold`, so setting it once here paints
    // every mode consistently.
    const color = settings().bold_color;
    if (color) {
      document.documentElement.style.setProperty("--mz-syntax-bold", color);
    } else {
      document.documentElement.style.removeProperty("--mz-syntax-bold");
    }
  });
  createEffect(() => {
    // Text selection background. `--mz-bg-selection` is consumed
    // by `::selection` in variables.css AND by the CM6 inline
    // theme in Editor.tsx (`.cm-selectionBackground`), so setting
    // it once here lives everywhere at once.
    const color = settings().selection_color;
    if (color) {
      document.documentElement.style.setProperty("--mz-bg-selection", color);
    } else {
      document.documentElement.style.removeProperty("--mz-bg-selection");
    }
  });

  createEffect(() => {
    const color = settings().drag_indicator_color;
    if (color) {
      document.documentElement.style.setProperty("--mz-drag-indicator", color);
    } else {
      document.documentElement.style.removeProperty("--mz-drag-indicator");
    }
  });

  createEffect(() => {
    const fontFamily = settings().font_family?.trim() || DEFAULT_FONT_FAMILY;
    document.documentElement.style.setProperty("--mz-font-sans", fontFamily);
  });

  createEffect(() => {
    const fontSize = Math.max(8, Math.round(settings().font_size || DEFAULT_SETTINGS.font_size));
    document.documentElement.style.setProperty("--mz-font-size-base", `${fontSize}px`);
    document.documentElement.style.setProperty("--mz-font-size-md", `${fontSize}px`);
    document.documentElement.style.setProperty("--mz-font-size-sm", `${Math.max(8, fontSize - 2)}px`);
    document.documentElement.style.setProperty("--mz-font-size-xs", `${Math.max(8, fontSize - 4)}px`);
    document.documentElement.style.setProperty("--mz-font-size-lg", `${fontSize + 2}px`);
  });

  // Apply user CSS snippets — Obsidian-style file-based model. Each
  // snippet is a `.css` file in `.mindzj/snippets/`; the enabled list
  // lives in settings. We maintain a single <style> element at the end
  // of <head> with the concatenated contents of all enabled snippets so
  // the user's rules cascade over the base theme.
  //
  // The effect re-runs whenever the enabled-snippet array changes (user
  // toggles a snippet) and also when `snippetsReloadTick()` increments
  // (user clicks "Refresh" or the watcher sees a file change).
  createEffect(async () => {
    const enabled = settings().enabled_css_snippets ?? [];
    snippetsReloadTick(); // subscribe for manual refresh
    await applyCssSnippets(enabled);
  });

  // Load settings from backend
  async function loadSettings() {
    let next = createDefaultSettings();
    try {
      const loaded = await invoke<PersistedSettings>("get_settings");
      next = normalizeLoadedSettings(loaded);
    } catch (e) {
      setSettings(next);
      return next;
    }

    try {
      const hotkeys = await invoke<HotkeyBinding[]>("get_hotkeys");
      next.hotkey_overrides = Object.fromEntries(
        hotkeys
          .filter((binding) => binding.command && binding.keys)
          .map((binding) => [binding.command, binding.keys]),
      );
    } catch (e) {
      console.warn("Failed to load hotkeys, using defaults:", e);
    }

    setSettings(next);
    return next;
  }

  // Update a single setting
  async function updateSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) {
    const next = { ...settings(), [key]: value };
    setSettings(next);
    try {
      await invoke("update_settings", {
        settings: serializeSettingsForBackend(next),
      });
      if (key === "hotkey_overrides") {
        await invoke("save_hotkeys", {
          bindings: hotkeyOverridesToBindings(
            (value as AppSettings["hotkey_overrides"]) ?? {},
          ),
        });
      }
    } catch (e) {
      console.error("Failed to save settings:", e);
    }
  }

  function resetSettings() {
    setSettings(createDefaultSettings());
  }

  // Toggle theme
  function toggleTheme() {
    const current = settings().theme;
    const next: Theme =
      current === "dark" ? "light" : current === "light" ? "system" : "dark";
    updateSetting("theme", next);
  }

  return {
    settings,
    loadSettings,
    updateSetting,
    toggleTheme,
    resetSettings,
  };
}

export const settingsStore = createRoot(createSettingsStore);

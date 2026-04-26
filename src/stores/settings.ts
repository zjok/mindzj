import { createSignal, createRoot, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_ATTACHMENT_FOLDER } from "../utils/vaultPaths";
import {
  BUILT_IN_SKIN_IDS,
  CUSTOM_SKIN_PREFIX,
  customSkinName,
  isCustomSkin,
  resolveDataTheme,
  skinMode,
} from "../styles/themes";

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

/**
 * Active skin identifier.
 *
 * Besides the original `"light" | "dark" | "system"` trio we now accept:
 *   - Any built-in preset ID from `src/styles/themes/index.ts`
 *     (`"github-dark"`, `"nord"`, `"tokyo-night"`, …).
 *   - A `"custom:<name>"` reference that points at
 *     `.mindzj/themes/<name>.css` inside the current vault.
 *
 * The type stays `string` on purpose — backend persistence is a plain
 * string, and narrowing it in TypeScript would force every caller to
 * cast when dealing with user-imported skins whose names we don't know
 * at compile time.
 */
export type Theme = string;
type PersistedTheme = Theme | "Light" | "Dark" | "System";
export type AiProviderType =
  | "Ollama"
  | "LMStudio"
  | "ApiKeyLLM"
  | "OpenAI"
  | "Claude"
  | "Grok"
  | "Gemini"
  | "DeepSeek"
  | "Custom";

export interface AiProviderConfig {
  id?: string | null;
  display_name?: string | null;
  provider_type: AiProviderType;
  endpoint: string | null;
  api_key?: string | null;
  has_api_key: boolean;
  model: string;
}

export interface AiSkill {
  id: string;
  name: string;
  description?: string | null;
  content: string;
}

interface PersistedSettings extends Omit<Partial<AppSettings>, "theme"> {
  theme?: PersistedTheme | null;
}

/** Theme IDs that the settings store must not forget about across reloads. */
export const KNOWN_SKIN_IDS: readonly string[] = [
  ...BUILT_IN_SKIN_IDS,
  "system",
];

/** Readable label for `custom:` prefix — re-exported so UIs can use it. */
export const CUSTOM_THEME_PREFIX = CUSTOM_SKIN_PREFIX;

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
  /** When true (default), bare URLs like `github.com/zjok/mindzj`
   *  and `https://example.com` are rendered as clickable links in
   *  reading + live-preview mode, and click dispatches to the user's
   *  default browser via the shell-plugin. When false, the same
   *  text renders as plain unstyled text and clicks are inert. */
  auto_link_urls: boolean;
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
  ai_provider: AiProviderConfig | null;
  ai_custom_providers: AiProviderConfig[];
  /** Per-model prompt overrides, keyed by aiModelSettingsKey(config). */
  ai_model_prompts: Record<string, string>;
  /** Per-vault reusable AI skills. */
  ai_skills: AiSkill[];
  /** Per-model selected skill ids, keyed by aiModelSettingsKey(config). */
  ai_model_skill_ids: Record<string, string[]>;
  /** Built-in voice provider for STT/TTS features. */
  ai_voice_provider: string;
  /** Built-in speech-to-text model identifier shown in settings. */
  ai_stt_model: string;
  /** xAI TTS voice id. */
  ai_tts_voice: string;
  /** xAI TTS language code or auto detection. */
  ai_tts_language: string;
  /** Absolute folder path for exported TTS audio files. */
  ai_voice_export_folder: string | null;
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
  auto_link_urls: true,
  selection_color: null,
  drag_indicator_color: null,
  css_snippet: null,
  enabled_css_snippets: [],
  attachment_folder: DEFAULT_ATTACHMENT_FOLDER,
  auto_update_links: true,
  default_new_note_location: "VaultRoot",
  template_folder: null,
  ai_provider: null,
  ai_custom_providers: [],
  ai_model_prompts: {},
  ai_skills: [],
  ai_model_skill_ids: {},
  ai_voice_provider: "Grok",
  ai_stt_model: "grok-stt",
  ai_tts_voice: "eve",
  ai_tts_language: "auto",
  ai_voice_export_folder: null,
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
  return {
    ...DEFAULT_SETTINGS,
    ai_custom_providers: [...DEFAULT_SETTINGS.ai_custom_providers],
    ai_model_prompts: { ...DEFAULT_SETTINGS.ai_model_prompts },
    ai_skills: [...DEFAULT_SETTINGS.ai_skills],
    ai_model_skill_ids: { ...DEFAULT_SETTINGS.ai_model_skill_ids },
    hotkey_overrides: { ...DEFAULT_SETTINGS.hotkey_overrides },
  };
}

export function aiModelSettingsKey(config: AiProviderConfig | null | undefined): string {
  if (!config) return "provider:Ollama|endpoint:http://localhost:11434/v1|model:llama3.2";
  const providerType = normalizeAiProviderType(config.provider_type);
  const id = typeof config.id === "string" ? config.id.trim() : "";
  if (id) return `id:${id}`;
  const endpoint = (config.endpoint ?? "").trim().replace(/\/+$/, "");
  const model = (config.model ?? "").trim();
  return `provider:${providerType}|endpoint:${endpoint}|model:${model || "(default)"}`;
}

function hotkeyOverridesToBindings(overrides: Record<string, string>): HotkeyBinding[] {
  return Object.entries(overrides)
    .filter(([, keys]) => typeof keys === "string" && keys.trim().length > 0)
    .map(([command, keys]) => ({ command, keys }));
}

function normalizeTheme(theme: PersistedTheme | null | undefined): Theme {
  if (typeof theme !== "string") return DEFAULT_SETTINGS.theme;
  const trimmed = theme.trim();
  if (!trimmed) return DEFAULT_SETTINGS.theme;
  // Normalize the three legacy enum spellings, but preserve any other
  // value (built-in preset IDs and `custom:<name>` references) verbatim.
  switch (trimmed) {
    case "Light":
    case "light":
      return "light";
    case "Dark":
    case "dark":
      return "dark";
    case "System":
    case "system":
      return "system";
    default:
      return trimmed;
  }
}

/**
 * Convert the in-memory skin ID back into the string shape the backend
 * expects. Historically this was the tagged enum `"Light"/"Dark"/"System"`;
 * now the backend accepts any string (see `deserialize_theme` in
 * `types.rs`), so we pass unknown IDs through unchanged. The three
 * legacy spellings are preserved so settings files written by older
 * versions of the app round-trip cleanly.
 */
function serializeTheme(theme: Theme): string {
  switch (theme) {
    case "light":
      return "Light";
    case "dark":
      return "Dark";
    case "system":
      return "System";
    default:
      return theme;
  }
}

function normalizeAiProviderType(type: unknown): AiProviderType {
  if (
    type === "Ollama"
    || type === "LMStudio"
    || type === "ApiKeyLLM"
    || type === "OpenAI"
    || type === "Claude"
    || type === "Grok"
    || type === "Gemini"
    || type === "DeepSeek"
    || type === "Custom"
  ) {
    return type;
  }
  return "Ollama";
}

function normalizeAiConfig(config: unknown): AiProviderConfig | null {
  if (!config || typeof config !== "object") return null;
  const raw = config as Partial<AiProviderConfig>;
  const providerType = normalizeAiProviderType(raw.provider_type);
  const apiKey =
    typeof raw.api_key === "string" && raw.api_key.trim()
      ? raw.api_key.trim()
      : null;
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id : null,
    display_name:
      typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name.trim()
        : null,
    provider_type: providerType,
    endpoint: typeof raw.endpoint === "string" && raw.endpoint.trim()
      ? raw.endpoint.trim()
      : null,
    api_key: apiKey,
    has_api_key: !!raw.has_api_key || !!apiKey,
    model: typeof raw.model === "string" ? raw.model : "",
  };
}

function normalizeAiSkill(skill: unknown): AiSkill | null {
  if (!skill || typeof skill !== "object") return null;
  const raw = skill as Partial<AiSkill>;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : "";
  const content = typeof raw.content === "string" ? raw.content : "";
  if (!id || !name) return null;
  return {
    id,
    name,
    description:
      typeof raw.description === "string" && raw.description.trim()
        ? raw.description.trim()
        : null,
    content,
  };
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function normalizeStringArrayRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue;
    result[key] = entry.filter((item): item is string => typeof item === "string");
  }
  return result;
}

function normalizeLoadedSettings(loaded?: PersistedSettings | null): AppSettings {
  const base = createDefaultSettings();
  const aiProvider = normalizeAiConfig(loaded?.ai_provider);
  const aiCustomProviders = Array.isArray(loaded?.ai_custom_providers)
    ? loaded!.ai_custom_providers
        .map((config) => normalizeAiConfig(config))
        .filter((config): config is AiProviderConfig => !!config)
    : base.ai_custom_providers;
  return {
    ...base,
    ...(loaded ?? {}),
    theme: normalizeTheme(loaded?.theme),
    ai_provider: aiProvider,
    ai_custom_providers: aiCustomProviders,
    ai_model_prompts: {
      ...base.ai_model_prompts,
      ...normalizeStringRecord(loaded?.ai_model_prompts),
    },
    ai_skills: Array.isArray(loaded?.ai_skills)
      ? loaded!.ai_skills
          .map((skill) => normalizeAiSkill(skill))
          .filter((skill): skill is AiSkill => !!skill)
      : base.ai_skills,
    ai_model_skill_ids: {
      ...base.ai_model_skill_ids,
      ...normalizeStringArrayRecord(loaded?.ai_model_skill_ids),
    },
    ai_voice_provider:
      typeof loaded?.ai_voice_provider === "string" && loaded.ai_voice_provider.trim()
        ? loaded.ai_voice_provider.trim()
        : base.ai_voice_provider,
    ai_stt_model:
      typeof loaded?.ai_stt_model === "string" && loaded.ai_stt_model.trim()
        ? loaded.ai_stt_model.trim()
        : base.ai_stt_model,
    ai_tts_voice:
      typeof loaded?.ai_tts_voice === "string" && loaded.ai_tts_voice.trim()
        ? loaded.ai_tts_voice.trim()
        : base.ai_tts_voice,
    ai_tts_language:
      typeof loaded?.ai_tts_language === "string" && loaded.ai_tts_language.trim()
        ? loaded.ai_tts_language.trim()
        : base.ai_tts_language,
    ai_voice_export_folder:
      typeof loaded?.ai_voice_export_folder === "string" && loaded.ai_voice_export_folder.trim()
        ? loaded.ai_voice_export_folder.trim()
        : null,
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

/**
 * Inject (or clear) the CSS of a `custom:<name>` skin into the DOM.
 *
 * Custom skins live on disk as `.mindzj/themes/<name>.css`. When the
 * user switches TO a custom skin we fetch the CSS via the Rust
 * `read_theme` command and put it in a single `<style
 * id="mz-custom-skin">` element at the END of `<head>` so its rules
 * cascade OVER the built-in `:root`/`[data-theme=...]` variable
 * definitions in `variables.css` and `themes/*.css`. Switching
 * AWAY (or the skin failing to load) clears the style element so
 * the built-in palette comes back on its own.
 */
async function applyCustomSkin(id: string | null) {
  let styleEl = document.getElementById("mz-custom-skin") as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "mz-custom-skin";
    document.head.appendChild(styleEl);
  }
  if (!id || !isCustomSkin(id)) {
    styleEl.textContent = "";
    return;
  }
  const name = customSkinName(id);
  if (!name) {
    styleEl.textContent = "";
    return;
  }
  try {
    // Backend returns the bare filename list, so we pass `<name>.css`.
    const css = await invoke<string>("read_theme", { name: `${name}.css` });
    styleEl.textContent = `/* custom skin: ${name} */\n${css}`;
  } catch (e) {
    console.warn(`[skin] failed to load custom theme "${name}":`, e);
    styleEl.textContent = "";
  }
}

function createSettingsStore() {
  const [settings, setSettings] = createSignal<AppSettings>(createDefaultSettings());

  // Apply skin (data-theme attribute + custom CSS injection) to the DOM.
  //
  // Built-in skins: we set `data-theme` to the skin ID and clear the
  // custom-skin <style> element. The matching CSS file in
  // `src/styles/themes/` is already loaded at build time, so the
  // browser's selector matching picks up the new variables
  // immediately.
  //
  // `system`: resolve to light/dark once via `prefers-color-scheme`;
  // we don't subscribe to changes here because the rest of the app
  // (and most users) treat "system" as a one-shot preference rather
  // than a live-updating binding.
  //
  // `custom:<name>`: still set `data-theme` to a stable sentinel
  // ("custom") so any `[data-theme="custom"]` rules in the injected
  // CSS match, then load the CSS contents from disk into a
  // single <style> tag at the end of <head>.
  createEffect(() => {
    const theme = settings().theme;
    if (isCustomSkin(theme)) {
      document.documentElement.setAttribute("data-theme", "custom");
      void applyCustomSkin(theme);
    } else {
      const resolved = resolveDataTheme(theme);
      document.documentElement.setAttribute("data-theme", resolved);
      void applyCustomSkin(null);
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

  // Toggle between light and dark. Preserves the "family" of the user's
  // current skin when possible — e.g. toggling from `github-dark` takes
  // you to `github-light`, toggling from `nord` (dark only) defaults to
  // the app's built-in light. For custom / unknown skins we fall back
  // to the app defaults so the toolbar button always produces a
  // visible change.
  function toggleTheme() {
    const current = settings().theme;
    const pairs: Record<string, string> = {
      dark: "light",
      light: "dark",
      "mindzj-dark-warm": "mindzj-light-warm",
      "mindzj-light-warm": "mindzj-dark-warm",
      dracula: "dracula-light",
      "dracula-light": "dracula",
      "github-dark": "github-light",
      "github-light": "github-dark",
      "atom-dark": "atom-light",
      "atom-light": "atom-dark",
      "one-dark": "one-light",
      "one-light": "one-dark",
      "sublime-dark": "sublime-light",
      "sublime-light": "sublime-dark",
      "tokyo-night": "tokyo-night-light",
      "tokyo-night-light": "tokyo-night",
      gruvbox: "gruvbox-light",
      "gruvbox-light": "gruvbox",
      catppuccin: "catppuccin-latte",
      "catppuccin-latte": "catppuccin",
      "rose-pine": "rose-pine-dawn",
      "rose-pine-dawn": "rose-pine",
      "everforest-dark": "everforest-light",
      "everforest-light": "everforest-dark",
      "solarized-dark": "solarized-light",
      "solarized-light": "solarized-dark",
    };
    const next: Theme = pairs[current] ?? (skinMode(current) === "dark" ? "light" : "dark");
    updateSetting("theme", next);
  }

  /**
   * Force a re-read of the currently-active custom skin from disk.
   * Called by the Settings → Appearance "Reload theme" button after
   * the user edits the `.css` file externally. No-op (but still
   * returns a resolved promise) when the active skin isn't a custom
   * one, so callers can safely `await` it unconditionally.
   */
  async function reloadCustomSkin(): Promise<void> {
    const current = settings().theme;
    if (isCustomSkin(current)) {
      await applyCustomSkin(current);
    }
  }

  return {
    settings,
    loadSettings,
    updateSetting,
    toggleTheme,
    resetSettings,
    reloadCustomSkin,
  };
}

export const settingsStore = createRoot(createSettingsStore);

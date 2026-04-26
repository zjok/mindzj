/**
 * MindZJ Settings Modal
 * Full-screen settings panel inspired by Obsidian's settings page.
 */

import { Component, Show, For, createSignal, createEffect, createMemo, onMount, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as dialogOpen } from "@tauri-apps/plugin-dialog";
import { Eye, EyeOff } from "lucide-solid";
import { BUILT_IN_ONLINE_PROVIDER_TYPES, GROK_STT_MODEL, GROK_TTS_LANGUAGE_OPTIONS, GROK_TTS_VOICES, aiStore, builtInModelOptions, defaultAiProviderConfig, isBuiltInOnlineProviderType } from "../../stores/ai";
import { aiModelSettingsKey, settingsStore, type AiProviderConfig, type AiProviderType, type AiSkill, type AppSettings, reloadCssSnippets, DEFAULT_FONT_FAMILY } from "../../stores/settings";
import {
  BUILT_IN_SKINS,
  CUSTOM_SKIN_PREFIX,
  type BuiltInSkin,
} from "../../styles/themes";
import { pluginStore, getPluginSettingTab, pluginsVersion } from "../../stores/plugins";
import {
  SettingToggle,
  SettingInput,
  SettingSelect,
  SettingColor,
  SettingSection,
  SettingSlider,
} from "./controls";
import { confirmDialog, promptDialog } from "../common/ConfirmDialog";
import { getLanguageOptions, t } from "../../i18n";

type SettingsCategory =
  | "editor"
  | "appearance"
  | "images"
  | "ai"
  | "files"
  | "hotkeys"
  | "plugins"
  | "plugin-settings"
  | "about";

interface SettingsModalProps {
  onClose: () => void;
}

const CATEGORIES: { id: SettingsCategory; key: string; icon: string }[] = [
  { id: "editor", key: "settings.editor", icon: "M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" },
  { id: "appearance", key: "settings.appearance", icon: "M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" },
  { id: "images", key: "settings.images", icon: "M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z M8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3z M21 15l-5-5L5 21" },
  { id: "ai", key: "settings.ai", icon: "M12 2a10 10 0 100 20 10 10 0 000-20z M8 12h8 M12 8v8 M7.5 7.5l9 9 M16.5 7.5l-9 9" },
  { id: "files", key: "settings.files", icon: "M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z M13 2v7h7" },
  { id: "hotkeys", key: "settings.hotkeys", icon: "M18 3a3 3 0 00-3 3v12a3 3 0 003 3 3 3 0 003-3 3 3 0 00-3-3H6a3 3 0 00-3 3 3 3 0 003 3 3 3 0 003-3V6a3 3 0 00-3-3 3 3 0 00-3 3 3 3 0 003 3h12a3 3 0 003-3 3 3 0 00-3-3z" },
  { id: "plugins", key: "settings.plugins", icon: "M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" },
  { id: "about", key: "settings.about", icon: "M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 16v-4 M12 8h.01" },
];

const FONT_FAMILY_OPTIONS = [
  { value: DEFAULT_FONT_FAMILY, label: "Inter / Cross-platform" },
  { value: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif', label: "Segoe UI / Windows" },
  { value: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Hiragino Sans GB", sans-serif', label: "SF Pro / macOS" },
  { value: '"Ubuntu", "Noto Sans", "DejaVu Sans", "Liberation Sans", sans-serif', label: "Ubuntu / Linux" },
  { value: '"Noto Sans", "PingFang SC", "Microsoft YaHei", sans-serif', label: "Noto Sans" },
  { value: '"Source Sans 3", "Segoe UI", sans-serif', label: "Source Sans 3" },
  { value: '"IBM Plex Sans", "Segoe UI", sans-serif', label: "IBM Plex Sans" },
  { value: 'Georgia, "Times New Roman", serif', label: "Georgia / Serif" },
];

export const SettingsModal: Component<SettingsModalProps> = (props) => {
  const [activeTab, setActiveTab] = createSignal<SettingsCategory>("editor");
  const [activePluginId, setActivePluginId] = createSignal<string | null>(null);
  const [activePluginName, setActivePluginName] = createSignal<string>("");
  const [aiApiKeyDraft, setAiApiKeyDraft] = createSignal("");
  const [aiApiKeyVisible, setAiApiKeyVisible] = createSignal(false);
  const [aiTestResult, setAiTestResult] = createSignal<string | null>(null);
  const [aiProviderSelectDraft, setAiProviderSelectDraft] = createSignal<string | null>(null);
  const [aiAddingModel, setAiAddingModel] = createSignal(false);
  const [aiAddModelDraft, setAiAddModelDraft] = createSignal("");
  const [aiAddEndpointDraft, setAiAddEndpointDraft] = createSignal("");
  const [aiSkillEditingId, setAiSkillEditingId] = createSignal<string | null>(null);
  const [aiSkillNameDraft, setAiSkillNameDraft] = createSignal("");
  const [aiSkillDescriptionDraft, setAiSkillDescriptionDraft] = createSignal("");
  const [aiSkillContentDraft, setAiSkillContentDraft] = createSignal("");
  let aiApiKeyLoadToken = 0;

  function handleKeydown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    // When we're on a plugin's settings sub-page, Escape steps BACK to
    // the plugin list (matching Obsidian's behaviour). A second Escape
    // on the main settings closes the modal entirely.
    if (activeTab() === "plugin-settings") {
      e.preventDefault();
      e.stopPropagation();
      setActiveTab("plugins");
      setActivePluginId(null);
      return;
    }
    props.onClose();
  }

  onMount(() => {
    // Capture phase so we handle Escape before any input inside the
    // plugin's injected settings UI can eat the keydown event.
    document.addEventListener("keydown", handleKeydown, true);
    // Listen for plugin settings navigation from plugin's openPluginSettings()
    const handleNav = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.pluginId) {
        // Look up plugin name from loaded plugins
        const plugins = (window as any).__mindzj_loadedPlugins || [];
        const found = plugins.find((p: any) => p.id === detail.pluginId);
        setActivePluginId(detail.pluginId);
        setActivePluginName(found?.manifest?.name || detail.pluginId);
        setActiveTab("plugin-settings");
      }
    };
    document.addEventListener("mindzj:settings-navigate", handleNav);
    onCleanup(() => document.removeEventListener("mindzj:settings-navigate", handleNav));
  });
  onCleanup(() => document.removeEventListener("keydown", handleKeydown, true));

  const s = () => settingsStore.settings();
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    settingsStore.updateSetting(key, value);
  const aiConfig = (): AiProviderConfig =>
    s().ai_provider ?? defaultAiProviderConfig("Ollama");
  const aiModelKey = () => aiModelSettingsKey(aiConfig());
  const customAiProviders = () => s().ai_custom_providers ?? [];
  const isApiKeyAiProvider = (config = aiConfig()) =>
    config.provider_type !== "Ollama" && config.provider_type !== "LMStudio";
  const isBuiltInOnlineAiProvider = (config = aiConfig()) =>
    isBuiltInOnlineProviderType(config.provider_type);
  const aiBuiltInModelOptions = (config = aiConfig()) => {
    const options = builtInModelOptions(config.provider_type);
    const current = config.model.trim();
    if (!current || options.some((option) => option.value === current)) return options;
    return [{ value: current, label: current }, ...options];
  };
  const aiCurrentApiProviderOption = () => {
    const config = aiConfig();
    if (!isApiKeyAiProvider(config)) return null;
    if (isBuiltInOnlineAiProvider(config)) return null;
    if (config.id && customAiProviders().some((item) => item.id === config.id)) return null;
    return {
      value: config.id ? `custom:${config.id}` : "current-api-key-llm",
      label: config.display_name || config.model || t("settings.aiProviderSavedFallback"),
    };
  };
  const aiProviderValueForConfig = (config: AiProviderConfig) => {
    if (
      config.provider_type === "Ollama"
      || config.provider_type === "LMStudio"
      || isBuiltInOnlineProviderType(config.provider_type)
      || (config.provider_type === "Custom" && !config.id)
    ) {
      return config.provider_type;
    }
    return config.id ? `custom:${config.id}` : "current-api-key-llm";
  };
  const aiProviderSelectValue = () => aiProviderSelectDraft() ?? aiProviderValueForConfig(aiConfig());
  const aiProviderOptions = createMemo(() => {
    const options = [
      { value: "LMStudio", label: "LM Studio" },
      { value: "Ollama", label: "Ollama" },
      ...BUILT_IN_ONLINE_PROVIDER_TYPES.map((provider) => ({
        value: provider,
        label: defaultAiProviderConfig(provider).display_name || provider,
      })),
      ...(aiCurrentApiProviderOption() ? [aiCurrentApiProviderOption()!] : []),
      ...customAiProviders()
        .filter((config) => !!config.id)
        .map((config) => ({
          value: `custom:${config.id}`,
          label: config.display_name || config.model || t("settings.aiProviderSavedFallback"),
        })),
    ];
    const selected = aiProviderSelectValue();
    if (!options.some((option) => option.value === selected)) {
      const config = aiConfig();
      options.push({
        value: selected,
        label: config.display_name || config.model || t("settings.aiProviderSavedFallback"),
      });
    }
    return options;
  });
  createEffect(() => {
    const draft = aiProviderSelectDraft();
    if (draft && draft === aiProviderValueForConfig(aiConfig())) {
      setAiProviderSelectDraft(null);
    }
  });
  const activeCustomProviderSaved = () => {
    const id = aiConfig().id;
    return !!id && customAiProviders().some((config) => config.id === id);
  };
  const isLocalAiProvider = (config = aiConfig()) =>
    config.provider_type === "Ollama" || config.provider_type === "LMStudio";
  const aiVoiceProviderOptions = [{ value: "Grok", label: "Grok STT / TTS" }];
  const aiSttModelOptions = [{ value: GROK_STT_MODEL, label: "Grok STT" }];
  const aiAddMode = () => aiAddingModel();
  const aiProviderKindLabel = () =>
    isLocalAiProvider() ? t("settings.aiLocalModel") : t("settings.aiOnlineModel");
  const aiOnlineEndpointPlaceholder = () => {
    const providerDefault = defaultAiProviderConfig(aiConfig().provider_type).endpoint;
    if (!aiAddMode() && providerDefault) return providerDefault;
    const model = aiAddMode()
      ? aiAddModelDraft().toLowerCase()
      : `${aiConfig().display_name ?? ""} ${aiConfig().model ?? ""}`.toLowerCase();
    if (model.includes("gemini")) return "https://generativelanguage.googleapis.com/v1beta";
    if (model.includes("grok") || model.includes("xai")) return "https://api.x.ai/v1";
    if (model.includes("claude")) return "https://api.anthropic.com/v1";
    if (model.includes("deepseek")) return "https://api.deepseek.com";
    return "https://api.openai.com/v1";
  };
  function loadAiApiKeyIntoDraft(config: AiProviderConfig) {
    const token = ++aiApiKeyLoadToken;
    if (aiAddMode()) {
      setAiApiKeyVisible(false);
      return;
    }
    if (!isApiKeyAiProvider(config)) {
      setAiApiKeyVisible(false);
      setAiApiKeyDraft("");
      return;
    }
    setAiApiKeyVisible(false);
    void aiStore.loadApiKey(config).then((key) => {
      if (token !== aiApiKeyLoadToken) return;
      setAiApiKeyDraft(key ?? "");
    });
  }
  createEffect(() => {
    loadAiApiKeyIntoDraft(aiConfig());
  });
  function selectAiProvider(value: string) {
    setAiTestResult(null);
    setAiApiKeyVisible(false);
    if (value === "current-api-key-llm") {
      setAiProviderSelectDraft(value);
      setAiAddingModel(false);
      loadAiApiKeyIntoDraft(aiConfig());
      return;
    }
    if (value.startsWith("custom:")) {
      const id = value.slice("custom:".length);
      const config = customAiProviders().find((item) => item.id === id)
        ?? (aiConfig().id === id ? aiConfig() : null);
      if (!config) {
        setAiProviderSelectDraft(null);
        return;
      }
      setAiProviderSelectDraft(value);
      setAiAddingModel(false);
      setAiApiKeyDraft("");
      set("ai_provider", { ...config });
      loadAiApiKeyIntoDraft(config);
      return;
    }
    const providerType = value as AiProviderType;
    const config = isBuiltInOnlineProviderType(providerType)
      ? customAiProviders().find((item) => item.provider_type === providerType && !item.id)
        ?? defaultAiProviderConfig(providerType)
      : defaultAiProviderConfig(providerType);
    setAiProviderSelectDraft(value);
    setAiAddingModel(false);
    setAiApiKeyDraft("");
    set("ai_provider", config);
    loadAiApiKeyIntoDraft(config);
  }
  function createApiKeyProviderConfig(): AiProviderConfig {
    return {
      ...defaultAiProviderConfig("ApiKeyLLM"),
      id: `api-key-llm-${Date.now()}`,
    };
  }
  function updateAiConfig(patch: Partial<AiProviderConfig>) {
    set("ai_provider", { ...aiConfig(), ...patch });
    setAiTestResult(null);
  }
  const aiModelPrompt = () => s().ai_model_prompts?.[aiModelKey()] ?? "";
  const aiSkills = () => s().ai_skills ?? [];
  const selectedAiSkillIds = () => new Set(s().ai_model_skill_ids?.[aiModelKey()] ?? []);
  function updateAiModelPrompt(value: string) {
    const key = aiModelKey();
    void set("ai_model_prompts", {
      ...(s().ai_model_prompts ?? {}),
      [key]: value,
    });
  }
  function updateAiModelSkillSelection(skillId: string, enabled: boolean) {
    const key = aiModelKey();
    const existing = s().ai_model_skill_ids?.[key] ?? [];
    const next = enabled
      ? Array.from(new Set([...existing, skillId]))
      : existing.filter((id) => id !== skillId);
    void set("ai_model_skill_ids", {
      ...(s().ai_model_skill_ids ?? {}),
      [key]: next,
    });
  }
  async function selectAiVoiceExportFolder() {
    try {
      const selected = await dialogOpen({ directory: true, title: t("settings.aiVoiceExportFolderSelect") });
      if (selected && typeof selected === "string") {
        await set("ai_voice_export_folder", selected);
      }
    } catch (e) {
      console.error("Failed to select AI voice export folder:", e);
    }
  }
  function resetAiSkillDrafts() {
    setAiSkillEditingId(null);
    setAiSkillNameDraft("");
    setAiSkillDescriptionDraft("");
    setAiSkillContentDraft("");
  }
  function editAiSkill(skill: AiSkill) {
    setAiSkillEditingId(skill.id);
    setAiSkillNameDraft(skill.name);
    setAiSkillDescriptionDraft(skill.description ?? "");
    setAiSkillContentDraft(skill.content);
  }
  async function saveAiSkill() {
    const name = aiSkillNameDraft().trim();
    if (!name) {
      setAiTestResult(t("settings.aiSkillNameRequired"));
      return;
    }
    const nextSkill: AiSkill = {
      id: aiSkillEditingId() || `skill-${Date.now()}`,
      name,
      description: aiSkillDescriptionDraft().trim() || null,
      content: aiSkillContentDraft().trim(),
    };
    const existing = aiSkills();
    const next = existing.some((skill) => skill.id === nextSkill.id)
      ? existing.map((skill) => (skill.id === nextSkill.id ? nextSkill : skill))
      : [...existing, nextSkill];
    await set("ai_skills", next);
    resetAiSkillDrafts();
    setAiTestResult(t("settings.aiSkillSaved"));
  }
  async function deleteAiSkill(skill: AiSkill) {
    const confirmed = await confirmDialog(
      t("settings.aiSkillDeleteConfirm", { name: skill.name }),
      { confirmLabel: t("common.delete"), variant: "danger" },
    );
    if (!confirmed) return;
    const nextSkills = aiSkills().filter((item) => item.id !== skill.id);
    const nextSelections = Object.fromEntries(
      Object.entries(s().ai_model_skill_ids ?? {}).map(([key, ids]) => [
        key,
        ids.filter((id) => id !== skill.id),
      ]),
    );
    await set("ai_skills", nextSkills);
    await set("ai_model_skill_ids", nextSelections);
    if (aiSkillEditingId() === skill.id) resetAiSkillDrafts();
    setAiTestResult(t("settings.aiSkillDeleted"));
  }
  async function saveAiProvider(showStatus = true): Promise<boolean> {
    const current = aiConfig();
    const providerDefault = defaultAiProviderConfig(current.provider_type);
    const next: AiProviderConfig = {
      ...current,
      endpoint: current.endpoint?.trim() || null,
      display_name: isBuiltInOnlineAiProvider(current)
        ? providerDefault.display_name ?? current.display_name ?? null
        : current.model.trim() || current.display_name || null,
    };
    if (!next.model.trim()) {
      if (showStatus) setAiTestResult(t("settings.aiModelRequired"));
      return false;
    }
    const value = aiApiKeyDraft().trim();
    if (isApiKeyAiProvider(next)) {
      next.api_key = value || null;
      next.has_api_key = value.length > 0;
    }
    if (isApiKeyAiProvider(next) && isBuiltInOnlineAiProvider(next)) {
      const providers = customAiProviders();
      const exists = providers.some((config) => config.provider_type === next.provider_type && !config.id);
      const updated = exists
        ? providers.map((config) => (config.provider_type === next.provider_type && !config.id ? next : config))
        : [...providers, next];
      await set("ai_custom_providers", updated);
    } else if (isApiKeyAiProvider(next)) {
      next.id = next.id || `api-key-llm-${Date.now()}`;
      const providers = customAiProviders();
      const exists = providers.some((config) => config.id === next.id);
      const updated = exists
        ? providers.map((config) => (config.id === next.id ? next : config))
        : [...providers, next];
      await set("ai_custom_providers", updated);
    }
    await set("ai_provider", next);
    setAiApiKeyDraft(value);
    setAiApiKeyVisible(false);
    if (showStatus) setAiTestResult(t("settings.aiProviderSaved"));
    return true;
  }
  async function saveNewAiProvider() {
    const model = aiAddModelDraft().trim();
    if (!model) {
      setAiTestResult(t("settings.aiModelRequired"));
      return;
    }
    const apiKey = aiApiKeyDraft().trim();
    const endpoint = aiAddEndpointDraft().trim();
    const next: AiProviderConfig = {
      ...createApiKeyProviderConfig(),
      model,
      display_name: model,
      endpoint: endpoint || null,
      api_key: apiKey || null,
      has_api_key: apiKey.length > 0,
    };
    await set("ai_custom_providers", [...customAiProviders(), next]);
    await set("ai_provider", next);
    setAiAddModelDraft("");
    setAiAddEndpointDraft("");
    setAiApiKeyDraft(apiKey);
    setAiApiKeyVisible(false);
    setAiAddingModel(false);
    setAiTestResult(t("settings.aiProviderSaved"));
  }
  async function deleteAiProvider() {
    const current = aiConfig();
    if (!current.id) return;
    const confirmed = await confirmDialog(
      t("settings.aiDeleteProviderConfirm", {
        name: current.display_name || current.model || t("settings.aiProviderSavedFallback"),
      }),
      { confirmLabel: t("common.delete"), variant: "danger" },
    );
    if (!confirmed) return;
    await set("ai_custom_providers", customAiProviders().filter((config) => config.id !== current.id));
    await set("ai_provider", defaultAiProviderConfig("Ollama"));
    setAiApiKeyDraft("");
    setAiApiKeyVisible(false);
    setAiAddingModel(false);
    setAiTestResult(t("settings.aiProviderDeleted"));
  }
  async function testAiConfig() {
    setAiTestResult(t("settings.aiTesting"));
    try {
      if (isApiKeyAiProvider()) {
        const saved = await saveAiProvider(false);
        if (!saved) {
          setAiTestResult(t("settings.aiModelRequired"));
          return;
        }
      }
      const result = await aiStore.testConnection(aiConfig());
      const lines = [t("settings.aiConnected")];
      if (result.model) {
        lines.push(t("settings.aiDetectedModel", { model: result.model }));
      }
      if (result.content) {
        lines.push(result.content);
      }
      setAiTestResult(lines.join("\n"));
    } catch (e: any) {
      setAiTestResult(`${t("settings.aiConnectionFailed")}: ${e?.message || String(e)}`);
    }
  }
  const fontFamilyOptions = createMemo(() => {
    const current = s().font_family?.trim() || DEFAULT_FONT_FAMILY;
    return FONT_FAMILY_OPTIONS.some((option) => option.value === current)
      ? FONT_FAMILY_OPTIONS
      : [{ value: current, label: t("settings.fontFamilyCustomOption") }, ...FONT_FAMILY_OPTIONS];
  });

  const renderCustomEditorSettings = () => (
    <SettingSection title={t("settings.custom")}>
      <SettingColor
        label={t("settings.accentColor")}
        description={t("settings.accentColorDescription")}
        value={s().accent_color || "#1aad3f"}
        onChange={(v) => set("accent_color", v)}
        onClear={() => set("accent_color", "#1aad3f")}
      />
      <SettingColor
        label={t("settings.headingColor")}
        description={t("settings.headingColorDescription")}
        value={s().heading_color || "#e5c07b"}
        onChange={(v) => set("heading_color", v)}
        onClear={() => set("heading_color", null)}
      />
      <SettingColor
        label={t("settings.linkColor")}
        description={t("settings.linkColorDescription")}
        value={s().link_color || "#528bff"}
        onChange={(v) => set("link_color", v)}
        onClear={() => set("link_color", null)}
      />
      <SettingColor
        label={t("settings.highlightColor")}
        description={t("settings.highlightColorDescription")}
        value={s().highlight_color || "#fff59d"}
        onChange={(v) => set("highlight_color", v)}
        onClear={() => set("highlight_color", null)}
      />
      <SettingColor
        label={t("settings.boldColor")}
        description={t("settings.boldColorDescription")}
        value={s().bold_color || "#e06c75"}
        onChange={(v) => set("bold_color", v)}
        onClear={() => set("bold_color", null)}
      />
      <SettingColor
        label={t("settings.selectionColor")}
        description={t("settings.selectionColorDescription")}
        value={s().selection_color || "#528bff"}
        onChange={(v) => set("selection_color", v)}
        onClear={() => set("selection_color", null)}
      />
      <SettingColor
        label={t("settings.dragIndicatorColor")}
        description={t("settings.dragIndicatorColorDescription")}
        value={s().drag_indicator_color || "#1aad3f"}
        onChange={(v) => set("drag_indicator_color", v)}
        onClear={() => set("drag_indicator_color", null)}
      />
      <SettingToggle
        label={t("settings.showMarkdownToolbar")}
        description={t("settings.showMarkdownToolbarDescription")}
        value={s().show_markdown_toolbar}
        onChange={(v) => set("show_markdown_toolbar", v)}
      />
      <SettingToggle
        label={t("settings.autoLinkUrls")}
        description={t("settings.autoLinkUrlsDescription")}
        value={s().auto_link_urls}
        onChange={(v) => set("auto_link_urls", v)}
      />
    </SettingSection>
  );

  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        "z-index": "9999",
        display: "flex",
        background: "rgba(0,0,0,0.5)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        style={{
          display: "flex",
          width: "min(1040px, 92vw)",
          height: "min(780px, 90vh)",
          margin: "auto",
          background: "var(--mz-bg-secondary)",
          "border-radius": "var(--mz-radius-lg)",
          "box-shadow": "0 20px 60px rgba(0,0,0,0.4)",
          overflow: "hidden",
          border: "1px solid var(--mz-border)",
        }}
      >
        {/* ===== LEFT: Category List ===== */}
        <nav
          style={{
            width: "200px",
            "min-width": "200px",
            background: "var(--mz-bg-tertiary)",
            "border-right": "1px solid var(--mz-border)",
            display: "flex",
            "flex-direction": "column",
            padding: "16px 0",
          }}
        >
          <div
            style={{
              padding: "0 16px 12px",
              "font-size": "var(--mz-font-size-lg)",
              "font-weight": "700",
              color: "var(--mz-text-primary)",
            }}
          >
            {t("settings.title")}
          </div>

          <For each={CATEGORIES}>
            {(cat) => (
              <button
                onClick={() => setActiveTab(cat.id)}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "10px",
                  width: "100%",
                  padding: "8px 16px",
                  border: "none",
                  background:
                    activeTab() === cat.id
                      ? "var(--mz-bg-active)"
                      : "transparent",
                  color:
                    activeTab() === cat.id
                      ? "var(--mz-accent)"
                      : "var(--mz-text-secondary)",
                  cursor: "pointer",
                  "font-size": "var(--mz-font-size-sm)",
                  "font-family": "var(--mz-font-sans)",
                  "font-weight": activeTab() === cat.id ? "600" : "400",
                  "text-align": "left",
                  transition: "all 100ms",
                  "border-left": activeTab() === cat.id ? "3px solid var(--mz-accent)" : "3px solid transparent",
                }}
                onMouseEnter={(e) => {
                  if (activeTab() !== cat.id)
                    e.currentTarget.style.background = "var(--mz-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (activeTab() !== cat.id)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d={cat.icon} />
                </svg>
                {t(cat.key)}
              </button>
            )}
          </For>

          {/* Active plugin settings entry (shown when viewing plugin settings) */}
          <Show when={activeTab() === "plugin-settings" && activePluginName()}>
            <div style={{ padding: "8px 0 0", "margin-top": "4px", "border-top": "1px solid var(--mz-border)" }}>
              <button
                style={{
                  display: "flex", "align-items": "center", gap: "10px",
                  width: "100%", padding: "8px 16px", border: "none",
                  background: "var(--mz-bg-active)", color: "var(--mz-accent)",
                  cursor: "pointer", "font-size": "var(--mz-font-size-sm)",
                  "font-family": "var(--mz-font-sans)", "font-weight": "600",
                  "text-align": "left", "border-left": "3px solid var(--mz-accent)",
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
                {activePluginName()}
              </button>
            </div>
          </Show>

          {/* Spacer */}
          <div style={{ flex: "1" }} />

          {/* Close button */}
          <button
            onClick={props.onClose}
            style={{
              margin: "8px 16px",
              padding: "6px",
              border: "1px solid var(--mz-border)",
              background: "transparent",
              color: "var(--mz-text-secondary)",
              "border-radius": "var(--mz-radius-sm)",
              cursor: "pointer",
              "font-size": "var(--mz-font-size-sm)",
              "font-family": "var(--mz-font-sans)",
            }}
          >
            {t("settings.close")}
          </button>
        </nav>

        {/* ===== RIGHT: Content Area ===== */}
        <div
          style={{
            flex: "1",
            overflow: "auto",
            padding: "24px 32px",
          }}
        >
          {/* Editor Settings */}
          <Show when={activeTab() === "editor"}>
            <h2 style={titleStyle}>{t("settings.editor")}</h2>

            <SettingSection title={t("settings.font")}>
              <SettingInput
                label={t("settings.fontSize")}
                description={t("settings.fontSizeDescription")}
                value={s().font_size}
                type="number"
                min={8}
                max={72}
                commitOnBlur
                onChange={(v) => {
                  const trimmed = v.trim();
                  if (!trimmed) return;
                  const parsed = Number.parseInt(trimmed, 10);
                  if (!Number.isFinite(parsed)) return;
                  set("font_size", Math.max(8, Math.min(72, parsed)));
                }}
              />
              <SettingSelect
                label={t("settings.fontFamily")}
                description={t("settings.fontFamilyDescription")}
                value={s().font_family || DEFAULT_FONT_FAMILY}
                options={fontFamilyOptions()}
                width="320px"
                onChange={(v) => set("font_family", v)}
              />
              <SettingInput
                label={t("settings.fontFamilyCustom")}
                description={t("settings.fontFamilyCustomDescription")}
                value={s().font_family}
                placeholder={DEFAULT_FONT_FAMILY}
                width="320px"
                onChange={(v) => set("font_family", v)}
              />
            </SettingSection>

            <SettingSection title={t("settings.editing")}>
              <SettingToggle
                label={t("settings.showLineNumbers")}
                description={t("settings.showLineNumbersDescription")}
                value={s().editor_line_numbers}
                onChange={(v) => set("editor_line_numbers", v)}
              />
              <SettingToggle
                label={t("settings.wordWrap")}
                description={t("settings.wordWrapDescription")}
                value={s().editor_word_wrap}
                onChange={(v) => set("editor_word_wrap", v)}
              />
              <SettingToggle
                label={t("settings.readableLineLength")}
                description={t("settings.readableLineLengthDescription")}
                value={s().editor_readable_line_length}
                onChange={(v) => set("editor_readable_line_length", v)}
              />
              <SettingToggle
                label={t("settings.spellCheck")}
                description={t("settings.spellCheckDescription")}
                value={s().editor_spell_check}
                onChange={(v) => set("editor_spell_check", v)}
              />
              <SettingToggle
                label={t("settings.vimMode")}
                description={t("settings.vimModeDescription")}
                value={s().editor_vim_mode}
                onChange={(v) => set("editor_vim_mode", v)}
              />
            </SettingSection>

            <SettingSection title={t("settings.saveSection")}>
              <SettingInput
                label={t("settings.autoSaveInterval")}
                description={t("settings.autoSaveIntervalDescription")}
                value={s().auto_save_interval_ms}
                type="number"
                min={500}
                max={30000}
                onChange={(v) => set("auto_save_interval_ms", parseInt(v) || 2000)}
              />
              <SettingSelect
                label={t("settings.defaultViewMode")}
                description={t("settings.defaultViewModeDescription")}
                value={s().default_view_mode}
                options={[
                  { value: "Source", label: t("settings.viewMode.source") },
                  { value: "LivePreview", label: t("settings.viewMode.livePreview") },
                  { value: "Reading", label: t("settings.viewMode.reading") },
                ]}
                onChange={(v) => set("default_view_mode", v)}
              />
            </SettingSection>

            {renderCustomEditorSettings()}
          </Show>

          {/* Appearance Settings */}
          <Show when={activeTab() === "appearance"}>
            <h2 style={titleStyle}>{t("settings.appearance")}</h2>

            <SettingSection title={t("common.interfaceLanguage")}>
              <div style={{ display: "flex", "justify-content": "flex-end", padding: "8px 0" }}>
                <select
                  title={t("common.interfaceLanguage")}
                  aria-label={t("common.interfaceLanguage")}
                  value={s().locale}
                  onChange={(event) => set("locale", event.currentTarget.value as AppSettings["locale"])}
                  style={titleSelectStyle}
                >
                  <For each={getLanguageOptions()}>
                    {(option) => <option value={option.value}>{option.label}</option>}
                  </For>
                </select>
              </div>
            </SettingSection>

            <SettingSection title={t("settings.themeSection")}>
              <SkinPickerPanel />
            </SettingSection>

            {/* CSS Snippets — Obsidian-style user stylesheet manager */}
            <CssSnippetsPanel />
          </Show>

          {/* Image Settings */}
          <Show when={activeTab() === "images"}>
            <h2 style={titleStyle}>{t("settings.images")}</h2>

            <SettingSection title={t("settings.contextMenu")}>
              <SettingInput
                label={t("settings.imageResizeOptions")}
                description={t("settings.imageResizeOptionsDescription")}
                value={s().image_resize_options}
                placeholder="25%, 33%, 50%, 100%"
                onChange={(v) => set("image_resize_options", v)}
              />
            </SettingSection>

            <SettingSection title={t("settings.ctrlClickBehavior")}>
              <SettingSelect
                label={t("settings.imageCtrlClick")}
                description={t("settings.imageCtrlClickDescription")}
                value={s().image_ctrl_click}
                options={[
                  { value: "open-in-new-tab", label: t("settings.imageCtrlClick.openInNewTab") },
                  { value: "open-in-default-app", label: t("settings.imageCtrlClick.openInDefaultApp") },
                  { value: "show-in-explorer", label: t("context.showInExplorer") },
                ]}
                onChange={(v) => set("image_ctrl_click", v as any)}
              />
            </SettingSection>

            <SettingSection title={t("settings.wheelZoom")}>
              <SettingToggle
                label={t("settings.enableWheelZoom")}
                description={t("settings.enableWheelZoomDescription")}
                value={s().image_wheel_zoom}
                onChange={(v) => set("image_wheel_zoom", v)}
              />
              <Show when={s().image_wheel_zoom}>
                <SettingSelect
                  label={t("settings.wheelModifier")}
                  description={t("settings.wheelModifierDescription")}
                  value={s().image_wheel_modifier}
                  options={[
                    { value: "Alt", label: "Alt" },
                    { value: "Ctrl", label: "Ctrl" },
                    { value: "Shift", label: "Shift" },
                  ]}
                  onChange={(v) => set("image_wheel_modifier", v as any)}
                />
                <SettingSlider
                  label={t("settings.wheelZoomStep")}
                  description={t("settings.wheelZoomStepDescription")}
                  value={s().image_wheel_zoom_step}
                  min={5}
                  max={50}
                  step={5}
                  suffix="%"
                  onReset={() => set("image_wheel_zoom_step", 20)}
                  onChange={(v) => set("image_wheel_zoom_step", v)}
                />
                <SettingToggle
                  label={t("settings.invertWheelDirection")}
                  description={t("settings.invertWheelDirectionDescription")}
                  value={s().image_wheel_invert}
                  onChange={(v) => set("image_wheel_invert", v)}
                />
              </Show>
            </SettingSection>
          </Show>

          {/* AI Settings */}
          <Show when={activeTab() === "ai"}>
            <div style={titleActionRowStyle}>
              <h2 style={{ ...titleStyle, "margin-bottom": "0" }}>{t("settings.ai")}</h2>
              <Show when={!aiAddMode()}>
                <button
                  onClick={() => {
                    setAiAddingModel(true);
                    setAiAddModelDraft("");
                    setAiAddEndpointDraft("");
                    setAiApiKeyDraft("");
                    setAiApiKeyVisible(false);
                    setAiTestResult(null);
                  }}
                  style={settingsButtonStyle}
                >
                  {t("settings.aiAddNewModel")}
                </button>
              </Show>
            </div>

            <SettingSection title={aiAddMode() ? t("settings.aiAddModelSection") : t("settings.aiProviderSection")}>
              <Show
                when={aiAddMode()}
                fallback={
                  <>
                    <SettingSelect
                      label={aiProviderKindLabel()}
                      description={isLocalAiProvider() ? t("settings.aiLocalModelDescription") : t("settings.aiOnlineModelDescription")}
                      value={aiProviderSelectValue()}
                      options={aiProviderOptions()}
                      width="190px"
                      onChange={selectAiProvider}
                    />
                    <Show when={isLocalAiProvider()}>
                      <SettingInput
                        label={t("settings.aiEndpoint")}
                        description={t("settings.aiEndpointDescription")}
                        value={aiConfig().endpoint ?? ""}
                        placeholder={defaultAiProviderConfig(aiConfig().provider_type).endpoint ?? ""}
                        width="290px"
                        onChange={(value) => updateAiConfig({ endpoint: value.trim() || null })}
                      />
                    </Show>
                    <Show when={isApiKeyAiProvider()}>
                      <Show
                        when={isBuiltInOnlineAiProvider()}
                        fallback={
                          <SettingInput
                            label={t("settings.aiModel")}
                            description={t("settings.aiModelDescription")}
                            value={aiConfig().model}
                            placeholder={t("settings.aiModelPlaceholder")}
                            width="290px"
                            onChange={(value) => updateAiConfig({ model: value.trim() })}
                          />
                        }
                      >
                        <SettingSelect
                          label={t("settings.aiModel")}
                          description={t("settings.aiModelDescription")}
                          value={aiConfig().model}
                          options={aiBuiltInModelOptions()}
                          width="290px"
                          onChange={(value) => updateAiConfig({ model: value })}
                        />
                      </Show>
                      <AiApiKeyInput
                        label={t("settings.aiApiKey")}
                        description={aiConfig().has_api_key ? t("settings.aiApiKeyStored") : t("settings.aiApiKeyDescription")}
                        value={aiApiKeyDraft()}
                        visible={aiApiKeyVisible()}
                        placeholder={t("settings.aiApiKeyPlaceholder")}
                        width="290px"
                        onChange={setAiApiKeyDraft}
                        onToggleVisible={() => setAiApiKeyVisible((value) => !value)}
                      />
                      <Show when={!isBuiltInOnlineAiProvider()}>
                        <SettingInput
                          label={t("settings.aiEndpoint")}
                          description={t("settings.aiOnlineEndpointDescription")}
                          value={aiConfig().endpoint ?? ""}
                          placeholder={aiOnlineEndpointPlaceholder()}
                          width="360px"
                          onChange={(value) => updateAiConfig({ endpoint: value.trim() || null })}
                        />
                      </Show>
                    </Show>
                    <div style={{ display: "flex", gap: "12px", "justify-content": "flex-end", padding: "14px 0 4px" }}>
                      <Show when={isApiKeyAiProvider()}>
                        <Show when={activeCustomProviderSaved()}>
                          <button
                            onClick={() => void deleteAiProvider()}
                            style={settingsDangerButtonStyle}
                          >
                            {t("settings.aiDeleteProvider")}
                          </button>
                        </Show>
                        <button
                          onClick={() => void saveAiProvider()}
                          style={settingsButtonStyle}
                        >
                          {t("common.save")}
                        </button>
                      </Show>
                      <button
                        onClick={() => void testAiConfig()}
                        style={settingsButtonStyle}
                      >
                        {t("settings.aiTest")}
                      </button>
                    </div>
                  </>
                }
              >
                <SettingInput
                  label={t("settings.aiModel")}
                  description={t("settings.aiModelDescription")}
                  value={aiAddModelDraft()}
                  placeholder={t("settings.aiModelPlaceholder")}
                  width="360px"
                  onChange={setAiAddModelDraft}
                />
                <AiApiKeyInput
                  label={t("settings.aiApiKey")}
                  description={t("settings.aiApiKeyDescription")}
                  value={aiApiKeyDraft()}
                  visible={aiApiKeyVisible()}
                  placeholder={t("settings.aiApiKeyPlaceholder")}
                  width="360px"
                  onChange={setAiApiKeyDraft}
                  onToggleVisible={() => setAiApiKeyVisible((value) => !value)}
                />
                <SettingInput
                  label={t("settings.aiEndpoint")}
                  description={t("settings.aiOnlineEndpointDescription")}
                  value={aiAddEndpointDraft()}
                  placeholder={aiOnlineEndpointPlaceholder()}
                  width="360px"
                  onChange={(value) => {
                    setAiAddEndpointDraft(value.trim());
                    setAiTestResult(null);
                  }}
                />
                <div style={{ display: "flex", gap: "36px", "justify-content": "flex-end", padding: "48px 0 4px" }}>
                  <button
                    onClick={() => {
                      setAiAddingModel(false);
                      setAiAddModelDraft("");
                      setAiAddEndpointDraft("");
                      setAiApiKeyDraft("");
                      setAiApiKeyVisible(false);
                      setAiTestResult(null);
                    }}
                    style={{ ...settingsButtonStyle, width: "160px" }}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    onClick={() => void saveNewAiProvider()}
                    style={{ ...settingsButtonStyle, width: "160px", color: "var(--mz-accent)", border: "1px solid var(--mz-accent)" }}
                  >
                    {t("settings.aiSaveAdd")}
                  </button>
                </div>
              </Show>
              <Show when={aiTestResult()}>
                <div
                  style={{
                    color: "var(--mz-text-muted)",
                    "font-size": "var(--mz-font-size-xs)",
                    "white-space": "pre-wrap",
                    "padding-top": "8px",
                    "user-select": "text",
                    "-webkit-user-select": "text",
                    cursor: "text",
                  }}
                >
                  {aiTestResult()}
                </div>
              </Show>
            </SettingSection>

            <Show when={!aiAddMode()}>
              <SettingSection title={t("settings.aiVoiceSection")}>
                <SettingSelect
                  label={t("settings.aiVoiceProvider")}
                  description={t("settings.aiVoiceProviderDescription")}
                  value={s().ai_voice_provider}
                  options={aiVoiceProviderOptions}
                  width="190px"
                  onChange={(value) => set("ai_voice_provider", value)}
                />
                <SettingSelect
                  label={t("settings.aiSttModel")}
                  description={t("settings.aiSttModelDescription")}
                  value={s().ai_stt_model}
                  options={aiSttModelOptions}
                  width="190px"
                  onChange={(value) => set("ai_stt_model", value)}
                />
                <SettingSelect
                  label={t("settings.aiTtsVoice")}
                  description={t("settings.aiTtsVoiceDescription")}
                  value={s().ai_tts_voice}
                  options={GROK_TTS_VOICES}
                  width="190px"
                  onChange={(value) => set("ai_tts_voice", value)}
                />
                <SettingSelect
                  label={t("settings.aiTtsLanguage")}
                  description={t("settings.aiTtsLanguageDescription")}
                  value={s().ai_tts_language}
                  options={GROK_TTS_LANGUAGE_OPTIONS}
                  width="190px"
                  onChange={(value) => set("ai_tts_language", value)}
                />
                <div style={{ ...settingsRowStyle, "align-items": "center", "flex-wrap": "wrap" }}>
                  <div style={{ flex: "1", "min-width": "180px" }}>
                    <div style={settingsLabelStyle}>{t("settings.aiVoiceExportFolder")}</div>
                    <div style={settingsDescStyle}>{t("settings.aiVoiceExportFolderDescription")}</div>
                  </div>
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-shrink": "0", "max-width": "100%" }}>
                    <input
                      type="text"
                      value={s().ai_voice_export_folder || ""}
                      placeholder={t("settings.aiVoiceExportFolderPlaceholder")}
                      onInput={(event) => set("ai_voice_export_folder", event.currentTarget.value.trim() || null)}
                      style={{ ...settingsInputBareStyle, ...aiVoiceExportInputStyle }}
                    />
                    <button
                      type="button"
                      onClick={() => void selectAiVoiceExportFolder()}
                      style={settingsButtonStyle}
                    >
                      {t("settings.aiVoiceExportFolderChoose")}
                    </button>
                    <button
                      type="button"
                      onClick={() => set("ai_voice_export_folder", null)}
                      style={settingsButtonStyle}
                    >
                      {t("common.reset")}
                    </button>
                  </div>
                </div>
              </SettingSection>

              <SettingSection title={t("settings.aiPromptSection")}>
                <div style={{ ...settingsRowStyle, "align-items": "flex-start", "flex-wrap": "wrap" }}>
                  <div style={{ flex: "1", "min-width": "180px" }}>
                    <div style={settingsLabelStyle}>{t("settings.aiModelPrompt")}</div>
                    <div style={settingsDescStyle}>
                      {t("settings.aiModelPromptDescription")}
                    </div>
                  </div>
                  <textarea
                    value={aiModelPrompt()}
                    placeholder={t("settings.aiModelPromptPlaceholder")}
                    onInput={(event) => updateAiModelPrompt(event.currentTarget.value)}
                    style={aiPromptTextareaStyle}
                  />
                </div>
              </SettingSection>

              <SettingSection title={t("settings.aiSkillsSection")}>
                <div style={{ ...settingsRowStyle, "align-items": "flex-start", "flex-wrap": "wrap" }}>
                  <div style={{ flex: "1", "min-width": "180px" }}>
                    <div style={settingsLabelStyle}>{t("settings.aiSkillEditor")}</div>
                    <div style={settingsDescStyle}>{t("settings.aiSkillsDescription")}</div>
                  </div>
                  <div style={aiSkillEditorStyle}>
                    <input
                      value={aiSkillNameDraft()}
                      placeholder={t("settings.aiSkillNamePlaceholder")}
                      onInput={(event) => setAiSkillNameDraft(event.currentTarget.value)}
                      style={{ ...settingsInputBareStyle, ...aiSkillInputStyle }}
                    />
                    <input
                      value={aiSkillDescriptionDraft()}
                      placeholder={t("settings.aiSkillDescriptionPlaceholder")}
                      onInput={(event) => setAiSkillDescriptionDraft(event.currentTarget.value)}
                      style={{ ...settingsInputBareStyle, ...aiSkillInputStyle }}
                    />
                    <textarea
                      value={aiSkillContentDraft()}
                      placeholder={t("settings.aiSkillContentPlaceholder")}
                      onInput={(event) => setAiSkillContentDraft(event.currentTarget.value)}
                      style={aiSkillTextareaStyle}
                    />
                    <div style={{ display: "flex", "justify-content": "flex-end", gap: "8px" }}>
                      <Show when={aiSkillEditingId()}>
                        <button onClick={resetAiSkillDrafts} style={settingsButtonStyle}>
                          {t("common.cancel")}
                        </button>
                      </Show>
                      <button onClick={() => void saveAiSkill()} style={settingsButtonStyle}>
                        {aiSkillEditingId() ? t("settings.aiSkillUpdate") : t("settings.aiSkillAdd")}
                      </button>
                    </div>
                  </div>
                </div>

                <div style={aiSkillListStyle}>
                  <Show
                    when={aiSkills().length > 0}
                    fallback={
                      <div style={{ color: "var(--mz-text-muted)", "font-size": "var(--mz-font-size-xs)", padding: "8px 0" }}>
                        {t("settings.aiSkillsEmpty")}
                      </div>
                    }
                  >
                    <For each={aiSkills()}>
                      {(skill) => {
                        const selected = () => selectedAiSkillIds().has(skill.id);
                        return (
                          <div style={aiSkillRowStyle}>
                            <label style={{ display: "flex", "align-items": "flex-start", gap: "10px", flex: "1", "min-width": "0", cursor: "pointer" }}>
                              <input
                                type="checkbox"
                                checked={selected()}
                                onChange={(event) => updateAiModelSkillSelection(skill.id, event.currentTarget.checked)}
                                style={{ "margin-top": "3px", "flex-shrink": "0" }}
                              />
                              <div style={{ "min-width": "0" }}>
                                <div style={settingsLabelStyle}>{skill.name}</div>
                                <Show when={skill.description}>
                                  <div style={settingsDescStyle}>{skill.description}</div>
                                </Show>
                                <div style={aiSkillPreviewStyle}>{skill.content || t("settings.aiSkillNoContent")}</div>
                              </div>
                            </label>
                            <div style={{ display: "flex", gap: "8px", "flex-shrink": "0" }}>
                              <button onClick={() => editAiSkill(skill)} style={settingsButtonStyle}>
                                {t("settings.aiSkillEdit")}
                              </button>
                              <button onClick={() => void deleteAiSkill(skill)} style={settingsDangerButtonStyle}>
                                {t("common.delete")}
                              </button>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </SettingSection>
            </Show>
          </Show>

          {/* Files & Links Settings */}
          <Show when={activeTab() === "files"}>
            <h2 style={titleStyle}>{t("settings.files")}</h2>

            <SettingSection title={t("settings.filesSection")}>
              <div style={{
                display: "flex", "align-items": "center", "justify-content": "space-between",
                padding: "8px 0", gap: "16px", "min-height": "40px",
              }}>
                <div style={{ flex: "1" }}>
                  <div style={{ "font-size": "var(--mz-font-size-sm)", color: "var(--mz-text-primary)", "font-weight": "500" }}>
                    {t("settings.attachmentFolder")}
                  </div>
                  <div style={{ "font-size": "var(--mz-font-size-xs)", color: "var(--mz-text-muted)", "margin-top": "2px" }}>
                    {t("settings.attachmentFolderDescription")}
                  </div>
                </div>
                <div style={{ display: "flex", "align-items": "center", gap: "6px", "flex-shrink": "0" }}>
                  <input
                    type="text"
                    value={s().attachment_folder}
                    placeholder=".mindzj/images"
                    onInput={(e) => set("attachment_folder", e.currentTarget.value || ".mindzj/images")}
                    style={{
                      width: "160px", padding: "4px 8px",
                      border: "1px solid var(--mz-border)", "border-radius": "var(--mz-radius-sm)",
                      background: "var(--mz-bg-primary)", color: "var(--mz-text-primary)",
                      "font-size": "var(--mz-font-size-sm)", "font-family": "var(--mz-font-sans)",
                    }}
                  />
                  <button
                    onClick={async () => {
                      try {
                        const selected = await dialogOpen({ directory: true, title: t("settings.selectAttachmentFolder") });
                        if (selected && typeof selected === "string") {
                          // Convert absolute path to relative path within vault
                          const vaultPath = (await invoke<any>("get_vault_info"))?.path;
                          if (vaultPath) {
                            const normalizedVault = String(vaultPath).replace(/\\/g, "/").replace(/\/$/, "");
                            const normalizedSelected = selected.replace(/\\/g, "/");
                            if (normalizedSelected.startsWith(normalizedVault + "/")) {
                              set("attachment_folder", normalizedSelected.slice(normalizedVault.length + 1));
                            } else {
                              // If outside vault, use the folder name as a relative path
                              const folderName = normalizedSelected.split("/").pop() || ".mindzj/images";
                              set("attachment_folder", folderName);
                            }
                          }
                        }
                      } catch (e) {
                        console.error("Failed to open folder dialog:", e);
                      }
                    }}
                    title={t("settings.selectLocalFolder")}
                    style={{
                      display: "flex", "align-items": "center", "justify-content": "center",
                      width: "32px", height: "28px",
                      border: "1px solid var(--mz-border)", "border-radius": "var(--mz-radius-sm)",
                      background: "var(--mz-bg-secondary)", color: "var(--mz-text-secondary)",
                      cursor: "pointer", "flex-shrink": "0",
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--mz-accent)"; e.currentTarget.style.color = "var(--mz-accent)"; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--mz-border)"; e.currentTarget.style.color = "var(--mz-text-secondary)"; }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                  </button>
                </div>
              </div>
              <SettingSelect
                label={t("settings.newNoteLocation")}
                description={t("settings.newNoteLocationDescription")}
                value={s().default_new_note_location}
                options={[
                  { value: "VaultRoot", label: t("settings.newNoteLocation.vaultRoot") },
                  { value: "SameFolder", label: t("settings.newNoteLocation.sameFolder") },
                ]}
                onChange={(v) => set("default_new_note_location", v)}
              />
              <SettingInput
                label={t("settings.templateFolder")}
                description={t("settings.templateFolderDescription")}
                value={s().template_folder || ""}
                placeholder="templates"
                onChange={(v) => set("template_folder", v || null)}
              />
            </SettingSection>

            <SettingSection title={t("settings.linksSection")}>
              <SettingToggle
                label={t("settings.autoUpdateLinks")}
                description={t("settings.autoUpdateLinksDescription")}
                value={s().auto_update_links}
                onChange={(v) => set("auto_update_links", v)}
              />
            </SettingSection>
          </Show>

          {/* Hotkeys Settings */}
          <Show when={activeTab() === "hotkeys"}>
            <h2 style={titleStyle}>{t("settings.hotkeys")}</h2>
            <HotkeysPanel />
          </Show>

          {/* Plugins */}
          <Show when={activeTab() === "plugins"}>
            <h2 style={titleStyle}>{t("settings.plugins")}</h2>
            <PluginsPanel onOpenPluginSettings={(id: string, name: string) => {
              setActivePluginId(id);
              setActivePluginName(name);
              setActiveTab("plugin-settings");
            }} />
          </Show>

          {/* Plugin Settings */}
          <Show when={activeTab() === "plugin-settings" && activePluginId()}>
            <div style={{ display: "flex", "align-items": "center", gap: "12px", "margin-bottom": "16px" }}>
              <button
                onClick={() => { setActiveTab("plugins"); setActivePluginId(null); }}
                style={{
                  display: "flex", "align-items": "center", gap: "4px",
                  border: "none", background: "transparent",
                  color: "var(--mz-text-muted)", cursor: "pointer",
                  "font-size": "var(--mz-font-size-sm)", "font-family": "var(--mz-font-sans)",
                  padding: "4px 8px", "border-radius": "var(--mz-radius-sm)",
                }}
                onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; e.currentTarget.style.color = "var(--mz-text-primary)"; }}
                onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--mz-text-muted)"; }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                {t("settings.backToPluginList")}
              </button>
            </div>
            <h2 style={titleStyle}>{t("settings.pluginSettingsTitle", { name: activePluginName() })}</h2>
            <PluginSettingsPanel pluginId={activePluginId()!} />
          </Show>

          {/* About */}
          <Show when={activeTab() === "about"}>
            <AboutPanel />
          </Show>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Plugins Panel
// ---------------------------------------------------------------------------

interface PluginManifestFE {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  author_url: string;
  min_app_version: string;
  is_desktop_only: boolean;
}

interface PluginInfoFE {
  manifest: PluginManifestFE;
  enabled: boolean;
  has_styles: boolean;
  dir_path: string;
  is_core?: boolean;
}

const PluginsPanel: Component<{ onOpenPluginSettings?: (id: string, name: string) => void }> = (props) => {
  const [plugins, setPlugins] = createSignal<PluginInfoFE[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [searchQuery, setSearchQuery] = createSignal("");

  onMount(async () => {
    await loadPlugins();
  });

  async function loadPlugins() {
    setLoading(true);
    try {
      const result = await invoke<PluginInfoFE[]>("list_plugins");
      setPlugins(result);
    } catch (e) {
      console.error("Failed to load plugins:", e);
    } finally {
      setLoading(false);
    }
  }

  async function togglePlugin(pluginId: string, enabled: boolean) {
    try {
      await invoke("toggle_plugin", { pluginId, enabled });
      setPlugins(prev => prev.map(p =>
        p.manifest.id === pluginId ? { ...p, enabled } : p
      ));
      // Load or unload the plugin immediately
      if (enabled) {
        await pluginStore.reloadPlugin(pluginId);
      } else {
        await pluginStore.unloadPlugin(pluginId);
      }
    } catch (e) {
      console.error("Failed to toggle plugin:", e);
    }
  }

  async function deletePlugin(pluginId: string, pluginName: string) {
    if (!confirm(t("settings.deletePluginConfirm", { name: pluginName }))) return;
    try {
      await invoke("delete_plugin", { pluginId });
      setPlugins(prev => prev.filter(p => p.manifest.id !== pluginId));
    } catch (e) {
      console.error("Failed to delete plugin:", e);
    }
  }

  const filteredPlugins = () => {
    const q = searchQuery().toLowerCase();
    if (!q) return plugins();
    return plugins().filter(p =>
      p.manifest.name.toLowerCase().includes(q) ||
      p.manifest.description.toLowerCase().includes(q) ||
      p.manifest.author.toLowerCase().includes(q) ||
      p.manifest.id.toLowerCase().includes(q)
    );
  };

  return (
    <>
      {/* Description */}
      <SettingSection title={t("settings.pluginManagement")}>
        <p style={{
          "font-size": "var(--mz-font-size-sm)",
          color: "var(--mz-text-secondary)",
          "line-height": "1.6",
          "margin-bottom": "12px",
        }}>
          {t("settings.pluginsDescription.start")} <code style={{
            background: "var(--mz-syntax-code-bg)",
            padding: "1px 6px",
            "border-radius": "var(--mz-radius-sm)",
            "font-family": "var(--mz-font-mono)",
            "font-size": "var(--mz-font-size-xs)",
          }}>.mindzj/plugins/</code> {t("settings.pluginsDescription.middle")} <code style={{
            background: "var(--mz-syntax-code-bg)",
            padding: "1px 6px",
            "border-radius": "var(--mz-radius-sm)",
            "font-family": "var(--mz-font-mono)",
            "font-size": "var(--mz-font-size-xs)",
          }}>manifest.json</code> {t("settings.pluginsDescription.and")} <code style={{
            background: "var(--mz-syntax-code-bg)",
            padding: "1px 6px",
            "border-radius": "var(--mz-radius-sm)",
            "font-family": "var(--mz-font-mono)",
            "font-size": "var(--mz-font-size-xs)",
          }}>main.js</code>{t("settings.pluginsDescription.end")}
        </p>
      </SettingSection>

      {/* Search & Install bar */}
      <div style={{
        display: "flex", gap: "8px", "margin-bottom": "16px",
      }}>
        <div style={{ flex: "1", position: "relative" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--mz-text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)" }}>
            <path d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
          </svg>
          <input
            type="text"
            placeholder={t("settings.pluginSearchPlaceholder")}
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
            style={{
              width: "100%",
              padding: "8px 12px 8px 32px",
              border: "1px solid var(--mz-border)",
              "border-radius": "var(--mz-radius-md)",
              background: "var(--mz-bg-primary)",
              color: "var(--mz-text-primary)",
              "font-size": "var(--mz-font-size-sm)",
              "font-family": "var(--mz-font-sans)",
            }}
          />
        </div>

        <button
          onClick={() => loadPlugins()}
          title={t("settings.refreshPlugins")}
          style={{
            display: "flex", "align-items": "center", "justify-content": "center",
            width: "36px", height: "36px",
            border: "1px solid var(--mz-border)",
            "border-radius": "var(--mz-radius-md)",
            background: "transparent",
            color: "var(--mz-text-secondary)",
            cursor: "pointer",
            "flex-shrink": "0",
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--mz-accent)"; e.currentTarget.style.color = "var(--mz-accent)"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--mz-border)"; e.currentTarget.style.color = "var(--mz-text-secondary)"; }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M23 4v6h-6M1 20v-6h6" />
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
      </div>

      {/* Plugin list */}
      <Show when={!loading()} fallback={
        <div style={{
          padding: "40px", "text-align": "center",
          color: "var(--mz-text-muted)", "font-size": "var(--mz-font-size-sm)",
        }}>
          {t("settings.loadingPlugins")}
        </div>
      }>
        <Show when={filteredPlugins().length > 0} fallback={
          <div style={{
            padding: "40px 20px", "text-align": "center",
            color: "var(--mz-text-muted)",
          }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style={{ opacity: "0.3", "margin-bottom": "12px" }}>
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            <div style={{ "font-size": "var(--mz-font-size-sm)", "margin-bottom": "8px" }}>
              {searchQuery() ? t("settings.noMatchingPlugins") : t("settings.noPluginsInstalled")}
            </div>
            <div style={{ "font-size": "var(--mz-font-size-xs)", opacity: "0.7" }}>
              {t("settings.installPluginHint")}
            </div>
          </div>
        }>
          <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
            <For each={filteredPlugins()}>
              {(plugin) => (
                <div style={{
                  display: "flex", "align-items": "center", gap: "12px",
                  padding: "12px 14px",
                  background: "var(--mz-bg-primary)",
                  "border-radius": "var(--mz-radius-md)",
                  border: "1px solid var(--mz-border)",
                  transition: "border-color 150ms",
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--mz-border-strong)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--mz-border)"; }}
                >
                  {/* Plugin icon */}
                  <div style={{
                    width: "40px", height: "40px",
                    display: "flex", "align-items": "center", "justify-content": "center",
                    background: plugin.enabled ? "var(--mz-accent-subtle)" : "var(--mz-bg-hover)",
                    "border-radius": "var(--mz-radius-md)",
                    "flex-shrink": "0",
                    color: plugin.enabled ? "var(--mz-accent)" : "var(--mz-text-muted)",
                  }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                    </svg>
                  </div>

                  {/* Plugin info */}
                  <div style={{ flex: "1", "min-width": "0" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "8px", "margin-bottom": "2px" }}>
                      <span style={{
                        "font-size": "var(--mz-font-size-sm)",
                        "font-weight": "600",
                        color: "var(--mz-text-primary)",
                        overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
                      }}>
                        {plugin.manifest.name}
                      </span>
                      <span style={{
                        "font-size": "10px",
                        color: "var(--mz-text-muted)",
                        background: "var(--mz-bg-hover)",
                        padding: "1px 6px",
                        "border-radius": "var(--mz-radius-sm)",
                        "flex-shrink": "0",
                      }}>
                        v{plugin.manifest.version}
                      </span>
                      <Show when={plugin.is_core}>
                        <span style={{
                          "font-size": "10px",
                          color: "var(--mz-accent)",
                          background: "var(--mz-accent-subtle)",
                          padding: "1px 6px",
                          "border-radius": "var(--mz-radius-sm)",
                          "flex-shrink": "0",
                          "font-weight": "600",
                        }}>
                          {t("settings.corePlugin")}
                        </span>
                      </Show>
                      <Show when={plugin.has_styles}>
                        <span style={{
                          "font-size": "10px",
                          color: "var(--mz-info)",
                          background: "rgba(97,175,239,0.1)",
                          padding: "1px 6px",
                          "border-radius": "var(--mz-radius-sm)",
                          "flex-shrink": "0",
                        }}>
                          CSS
                        </span>
                      </Show>
                    </div>
                    <div style={{
                      "font-size": "var(--mz-font-size-xs)",
                      color: "var(--mz-text-muted)",
                      overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap",
                    }}>
                      {plugin.manifest.description || plugin.manifest.id}
                    </div>
                    <div style={{
                      "font-size": "10px",
                      color: "var(--mz-text-muted)",
                      "margin-top": "2px",
                      opacity: "0.7",
                    }}>
                      {plugin.manifest.author ? t("settings.byAuthor", { author: plugin.manifest.author }) : ""}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-shrink": "0" }}>
                    {/* Settings button — shown for ALL enabled plugins */}
                    <Show when={plugin.enabled}>
                      <button
                        onClick={() => props.onOpenPluginSettings?.(plugin.manifest.id, plugin.manifest.name)}
                        title={t("settings.pluginSettings")}
                        style={{
                          width: "28px", height: "28px",
                          display: "flex", "align-items": "center", "justify-content": "center",
                          border: "none", "border-radius": "var(--mz-radius-sm)",
                          background: "transparent",
                          color: "var(--mz-text-muted)",
                          cursor: "pointer",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = "var(--mz-bg-hover)"; e.currentTarget.style.color = "var(--mz-accent)"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--mz-text-muted)"; }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
                        </svg>
                      </button>
                    </Show>

                    {/* Delete button — hidden for core plugins */}
                    <Show when={!plugin.is_core}>
                      <button
                        onClick={() => deletePlugin(plugin.manifest.id, plugin.manifest.name)}
                        title={t("settings.deletePlugin")}
                        style={{
                          width: "28px", height: "28px",
                          display: "flex", "align-items": "center", "justify-content": "center",
                          border: "none", "border-radius": "var(--mz-radius-sm)",
                          background: "transparent",
                          color: "var(--mz-text-muted)",
                          cursor: "pointer",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = "rgba(224,108,117,0.15)"; e.currentTarget.style.color = "var(--mz-error)"; }}
                        onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "var(--mz-text-muted)"; }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                        </svg>
                      </button>
                    </Show>

                    {/* Toggle switch — core plugins are always enabled */}
                    <button
                      onClick={() => { if (!plugin.is_core) togglePlugin(plugin.manifest.id, !plugin.enabled); }}
                      style={{
                        width: "40px", height: "22px",
                        "border-radius": "11px",
                        border: "none",
                        background: plugin.enabled ? "var(--mz-accent)" : "var(--mz-bg-hover)",
                        cursor: plugin.is_core ? "default" : "pointer",
                        position: "relative",
                        transition: "background 150ms ease",
                        "flex-shrink": "0",
                        opacity: plugin.is_core ? "0.7" : "1",
                      }}
                      title={plugin.is_core ? t("settings.corePluginCannotDisable") : ""}
                    >
                      <span style={{
                        position: "absolute",
                        top: "2px",
                        left: plugin.enabled ? "20px" : "2px",
                        width: "18px", height: "18px",
                        "border-radius": "50%",
                        background: "white",
                        transition: "left 150ms ease",
                        "box-shadow": "0 1px 3px rgba(0,0,0,0.3)",
                      }} />
                    </button>
                  </div>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </>
  );
};

// ---------------------------------------------------------------------------
// Hotkeys Panel
// ---------------------------------------------------------------------------

interface HotkeyDef {
  command: string;
  labelKey: string;
  defaultKeys: string;
}

const DEFAULT_HOTKEYS: HotkeyDef[] = [
  { command: "save", labelKey: "hotkeys.saveFile", defaultKeys: "Ctrl+S" },
  { command: "new-note", labelKey: "hotkeys.newNote", defaultKeys: "Ctrl+N" },
  { command: "command-palette", labelKey: "hotkeys.commandPalette", defaultKeys: "Ctrl+P" },
  { command: "command-palette-alt", labelKey: "hotkeys.commandPaletteAlt", defaultKeys: "Ctrl+O" },
  { command: "ai-control", labelKey: "hotkeys.aiPanel", defaultKeys: "Alt+`" },
  { command: "close-tab", labelKey: "hotkeys.closeTab", defaultKeys: "Ctrl+W" },
  { command: "reopen-tab", labelKey: "hotkeys.reopenTab", defaultKeys: "Ctrl+Shift+T" },
  { command: "tab-prev", labelKey: "hotkeys.tabPrev", defaultKeys: "Ctrl+Shift+Left" },
  { command: "tab-next", labelKey: "hotkeys.tabNext", defaultKeys: "Ctrl+Shift+Right" },
  { command: "toggle-window-visible", labelKey: "hotkeys.toggleWindowVisible", defaultKeys: "Ctrl+J" },
  { command: "toggle-sidebar", labelKey: "hotkeys.toggleSidebar", defaultKeys: "Ctrl+`" },
  { command: "toggle-view-mode", labelKey: "hotkeys.toggleViewMode", defaultKeys: "Ctrl+E" },
  { command: "task-list", labelKey: "hotkeys.taskList", defaultKeys: "Ctrl+L" },
  { command: "code-block", labelKey: "hotkeys.codeBlock", defaultKeys: "Ctrl+Shift+C" },
  { command: "settings", labelKey: "hotkeys.openSettings", defaultKeys: "Ctrl+," },
  { command: "zoom-in", labelKey: "hotkeys.zoomIn", defaultKeys: "Ctrl+=" },
  { command: "zoom-out", labelKey: "hotkeys.zoomOut", defaultKeys: "Ctrl+-" },
  { command: "zoom-reset", labelKey: "hotkeys.resetZoom", defaultKeys: "Ctrl+0" },
  { command: "bold", labelKey: "toolbar.bold", defaultKeys: "Ctrl+B" },
  { command: "italic", labelKey: "toolbar.italic", defaultKeys: "Ctrl+I" },
  { command: "strikethrough", labelKey: "toolbar.strikethrough", defaultKeys: "Ctrl+Shift+S" },
  { command: "underline", labelKey: "toolbar.underline", defaultKeys: "Ctrl+U" },
  { command: "highlight", labelKey: "toolbar.highlight", defaultKeys: "Ctrl+Shift+H" },
  { command: "link", labelKey: "hotkeys.insertLink", defaultKeys: "Ctrl+K" },
  { command: "code", labelKey: "hotkeys.inlineCode", defaultKeys: "Ctrl+Shift+E" },
  { command: "heading-1", labelKey: "hotkeys.heading1", defaultKeys: "Ctrl+1" },
  { command: "heading-2", labelKey: "hotkeys.heading2", defaultKeys: "Ctrl+2" },
  { command: "heading-3", labelKey: "hotkeys.heading3", defaultKeys: "Ctrl+3" },
  { command: "heading-4", labelKey: "hotkeys.heading4", defaultKeys: "Ctrl+4" },
  { command: "heading-5", labelKey: "hotkeys.heading5", defaultKeys: "Ctrl+5" },
  { command: "heading-6", labelKey: "hotkeys.heading6", defaultKeys: "Ctrl+6" },
  { command: "normal-text", labelKey: "hotkeys.normalText", defaultKeys: "Ctrl+0" },
  { command: "search", labelKey: "hotkeys.searchFileContent", defaultKeys: "Ctrl+Shift+F" },
  { command: "find-in-file", labelKey: "hotkeys.findInFile", defaultKeys: "Ctrl+F" },
  { command: "delete-line", labelKey: "hotkeys.deleteLine", defaultKeys: "Ctrl+D" },
  { command: "duplicate-line", labelKey: "hotkeys.duplicateLine", defaultKeys: "Ctrl+Shift+D" },
  { command: "move-line-up", labelKey: "hotkeys.moveLineUp", defaultKeys: "Alt+Up" },
  { command: "move-line-down", labelKey: "hotkeys.moveLineDown", defaultKeys: "Alt+Down" },
  { command: "indent", labelKey: "hotkeys.indentMore", defaultKeys: "Ctrl+]" },
  { command: "outdent", labelKey: "hotkeys.indentLess", defaultKeys: "Ctrl+[" },
  { command: "toggle-comment", labelKey: "hotkeys.toggleComment", defaultKeys: "Ctrl+/" },
  { command: "toggle-blockquote", labelKey: "hotkeys.toggleBlockquote", defaultKeys: "Ctrl+Shift+." },
  { command: "undo", labelKey: "toolbar.undo", defaultKeys: "Ctrl+Z" },
  { command: "redo", labelKey: "toolbar.redo", defaultKeys: "Ctrl+Shift+Z" },
  { command: "screenshot", labelKey: "hotkeys.screenshot", defaultKeys: "Alt+G" },
  { command: "plugin:timestamp-header:insert-timestamp", labelKey: "hotkeys.insertTimestamp", defaultKeys: "Alt+F" },
  { command: "plugin:timestamp-header:insert-separator", labelKey: "hotkeys.insertSeparator", defaultKeys: "Alt+A" },
];

const HotkeysPanel: Component = () => {
  const [searchQuery, setSearchQuery] = createSignal("");
  const [capturing, setCapturing] = createSignal<string | null>(null);

  // Get the display keys for a hotkey (custom override or default)
  const getDisplayKeys = (hotkey: HotkeyDef) => {
    const overrides = settingsStore.settings().hotkey_overrides || {};
    return overrides[hotkey.command] || hotkey.defaultKeys;
  };

  const filtered = () => {
    const q = searchQuery().toLowerCase();
    if (!q) return DEFAULT_HOTKEYS;
    return DEFAULT_HOTKEYS.filter(
      (h) =>
        t(h.labelKey).toLowerCase().includes(q) ||
        h.command.toLowerCase().includes(q) ||
        getDisplayKeys(h).toLowerCase().includes(q),
    );
  };

  // Sync global flag so App.tsx's handleGlobalKeydown skips shortcuts while capturing
  createEffect(() => {
    (window as any).__mindzj_hotkey_capturing = !!capturing();
  });

  function handleKeyCapture(e: KeyboardEvent) {
    if (!capturing()) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.key === "Escape") {
      setCapturing(null);
      return;
    }

    // Build key string — support combo shortcuts like Ctrl+L, Ctrl+Shift+L
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    if (e.metaKey) parts.push("Meta");

    // Don't record modifier-only presses
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;

    // Normalize the key name
    let keyName = e.key;
    if (keyName.length === 1) {
      keyName = keyName.toUpperCase();
    } else if (keyName === "ArrowUp") {
      keyName = "Up";
    } else if (keyName === "ArrowDown") {
      keyName = "Down";
    } else if (keyName === "ArrowLeft") {
      keyName = "Left";
    } else if (keyName === "ArrowRight") {
      keyName = "Right";
    } else if (keyName === " ") {
      keyName = "Space";
    }

    parts.push(keyName);
    const combo = parts.join("+");

    const cmd = capturing()!;
    // Save the custom hotkey override to settings
    const currentOverrides = { ...(settingsStore.settings().hotkey_overrides || {}) };
    currentOverrides[cmd] = combo;
    settingsStore.updateSetting("hotkey_overrides", currentOverrides);

    setCapturing(null);
  }

  onMount(() => document.addEventListener("keydown", handleKeyCapture, true));
  onCleanup(() => document.removeEventListener("keydown", handleKeyCapture, true));

  // Reset a hotkey override back to its default
  function resetHotkey(command: string) {
    const currentOverrides = { ...(settingsStore.settings().hotkey_overrides || {}) };
    delete currentOverrides[command];
    settingsStore.updateSetting("hotkey_overrides", currentOverrides);
  }

  return (
    <>
      <input
        type="text"
        placeholder={t("settings.hotkeysSearchPlaceholder")}
        value={searchQuery()}
        onInput={(e) => setSearchQuery(e.currentTarget.value)}
        style={{
          width: "100%",
          padding: "8px 12px",
          border: "1px solid var(--mz-border)",
          "border-radius": "var(--mz-radius-md)",
          background: "var(--mz-bg-primary)",
          color: "var(--mz-text-primary)",
          "font-size": "var(--mz-font-size-sm)",
          "font-family": "var(--mz-font-sans)",
          "margin-bottom": "16px",
        }}
      />

      <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
        <For each={filtered()}>
          {(hotkey) => {
            const overrides = () => settingsStore.settings().hotkey_overrides || {};
            const isCustom = () => !!overrides()[hotkey.command];
            const displayKeys = () => overrides()[hotkey.command] || hotkey.defaultKeys;

            return (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "8px 12px",
                  "border-radius": "var(--mz-radius-sm)",
                  background:
                    capturing() === hotkey.command
                      ? "var(--mz-accent-subtle)"
                      : "transparent",
                }}
                onMouseEnter={(e) => {
                  if (capturing() !== hotkey.command)
                    e.currentTarget.style.background = "var(--mz-bg-hover)";
                }}
                onMouseLeave={(e) => {
                  if (capturing() !== hotkey.command)
                    e.currentTarget.style.background = "transparent";
                }}
              >
                <span
                  style={{
                    "font-size": "var(--mz-font-size-sm)",
                    color: "var(--mz-text-primary)",
                  }}
                >
                  {t(hotkey.labelKey)}
                </span>
                <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                  {/* Reset button (only shown for custom overrides) */}
                  <Show when={isCustom()}>
                    <button
                      onClick={() => resetHotkey(hotkey.command)}
                      title={t("settings.resetToDefault", { keys: hotkey.defaultKeys })}
                      style={{
                        display: "flex", "align-items": "center", "justify-content": "center",
                        width: "22px", height: "22px",
                        border: "none", background: "transparent",
                        color: "var(--mz-text-muted)", cursor: "pointer",
                        "border-radius": "var(--mz-radius-sm)",
                        "font-size": "12px",
                      }}
                      onMouseEnter={e => { e.currentTarget.style.color = "var(--mz-text-primary)"; e.currentTarget.style.background = "var(--mz-bg-active)"; }}
                      onMouseLeave={e => { e.currentTarget.style.color = "var(--mz-text-muted)"; e.currentTarget.style.background = "transparent"; }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    </button>
                  </Show>
                  {/* Hotkey button */}
                  <button
                    onClick={() =>
                      setCapturing(
                        capturing() === hotkey.command ? null : hotkey.command,
                      )
                    }
                    style={{
                      padding: "3px 10px",
                      border: capturing() === hotkey.command
                        ? "1px solid var(--mz-accent)"
                        : isCustom()
                          ? "1px solid var(--mz-accent)"
                          : "1px solid var(--mz-border)",
                      "border-radius": "var(--mz-radius-sm)",
                      background: capturing() === hotkey.command
                        ? "var(--mz-accent-subtle)"
                        : "var(--mz-bg-tertiary)",
                      color: capturing() === hotkey.command
                        ? "var(--mz-accent)"
                        : isCustom()
                          ? "var(--mz-accent)"
                          : "var(--mz-text-secondary)",
                      cursor: "pointer",
                      "font-size": "var(--mz-font-size-xs)",
                      "font-family": "var(--mz-font-mono)",
                      "min-width": "80px",
                      "text-align": "center",
                    }}
                  >
                    {capturing() === hotkey.command
                      ? t("settings.pressShortcut")
                      : displayKeys()}
                  </button>
                </div>
              </div>
            );
          }}
        </For>
      </div>
    </>
  );
};

// ---------------------------------------------------------------------------
// About Panel — comprehensive info + donation links
// ---------------------------------------------------------------------------

async function openExternalUrl(url: string) {
  try {
    const shell = await import("@tauri-apps/plugin-shell");
    await shell.open(url);
  } catch (e) {
    console.error("Failed to open external URL:", e);
  }
}

const APP_VERSION = "0.1.4";
const APP_RELEASE_DATE = "2026-04";
const APP_REPO_URL = "https://github.com/zjok/mindzj";
const APP_ISSUE_URL = "https://github.com/zjok/mindzj/issues";
const APP_RELEASES_URL = "https://github.com/zjok/mindzj/releases";
const APP_DOCS_URL = "https://github.com/zjok/mindzj/tree/main/docs";
const DONATION_BMC_URL = "https://www.buymeacoffee.com/superjohn";
const DONATION_KOFI_URL = "https://ko-fi.com/superjohn";
const DONATION_PAYPAL_URL = "https://paypal.me/TanCat997";

const AboutPanel: Component = () => {
  return (
    <div>
      {/* Hero card — logo, name, tagline, version */}
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          gap: "12px",
          padding: "32px 24px",
          background: "var(--mz-bg-secondary)",
          border: "1px solid var(--mz-border)",
          "border-radius": "var(--mz-radius-md)",
          "margin-bottom": "24px",
          "text-align": "center",
        }}
      >
        {/* Icon — the real 512×512 app icon from src-tauri/icons,
            copied into public/ at build-time so Vite can serve it.
            Rendered at a fixed 64×64 box per the design spec. */}
        <img
          src="/mindzj-logo.png"
          alt="MindZJ logo"
          width="64"
          height="64"
          style={{
            width: "64px",
            height: "64px",
            "border-radius": "12px",
            "image-rendering": "auto",
            "user-select": "none",
            "-webkit-user-drag": "none",
          }}
        />
        <h1
          style={{
            "font-size": "2em",
            "font-weight": "800",
            margin: "4px 0 0 0",
            color: "var(--mz-text-primary)",
            "letter-spacing": "0.5px",
          }}
        >
          MindZJ
        </h1>
        <div
          style={{
            "font-size": "var(--mz-font-size-sm)",
            color: "var(--mz-text-muted)",
          }}
        >
          {t("common.version")} {APP_VERSION}
        </div>
        <div
          style={{
            "font-size": "var(--mz-font-size-sm)",
            color: "var(--mz-text-muted)",
          }}
        >
          {t("common.author")}: SuperJohn
        </div>
        <p
          style={{
            "font-size": "var(--mz-font-size-base)",
            color: "var(--mz-text-secondary)",
            "line-height": "1.7",
            "max-width": "520px",
            margin: "8px 0 0 0",
          }}
        >
          {t("settings.aboutDescription")}
        </p>
        <div
          style={{
            "font-size": "var(--mz-font-size-sm)",
            color: "var(--mz-accent)",
            "font-weight": "600",
            "margin-top": "4px",
          }}
        >
          {t("settings.aboutTagline")}
        </div>
        <button
          onClick={() => void openExternalUrl(APP_REPO_URL)}
          style={{
            display: "inline-flex",
            "align-items": "center",
            gap: "8px",
            padding: "8px 16px",
            "margin-top": "8px",
            background: "var(--mz-bg-tertiary)",
            border: "1px solid var(--mz-border)",
            "border-radius": "var(--mz-radius-md)",
            color: "var(--mz-accent)",
            cursor: "pointer",
            "font-size": "var(--mz-font-size-sm)",
            "font-weight": "600",
            "font-family": "var(--mz-font-sans)",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--mz-bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "var(--mz-bg-tertiary)";
          }}
        >
          <span>📦</span>
          <span>{t("settings.githubRepo")}</span>
        </button>
      </div>

      {/* Donation card */}
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          gap: "16px",
          padding: "24px 24px 28px",
          background: "var(--mz-bg-secondary)",
          border: "1px solid var(--mz-border)",
          "border-radius": "var(--mz-radius-md)",
          "margin-bottom": "24px",
        }}
      >
        <div
          style={{
            "font-size": "1.05em",
            "font-weight": "700",
            color: "var(--mz-text-primary)",
          }}
        >
          ☕ {t("settings.support")}
        </div>
        <div
          style={{
            "font-size": "var(--mz-font-size-sm)",
            color: "var(--mz-text-secondary)",
            "text-align": "center",
            "max-width": "520px",
            "line-height": "1.6",
          }}
        >
          {t("settings.supportMessage")}
        </div>
        <div
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            gap: "12px",
            "justify-content": "center",
          }}
        >
          {/* Buy Me a Coffee */}
          <button
            onClick={() => void openExternalUrl(DONATION_BMC_URL)}
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "8px",
              padding: "10px 20px",
              background: "#FFDD00",
              color: "#000",
              border: "none",
              "border-radius": "8px",
              cursor: "pointer",
              "font-size": "var(--mz-font-size-sm)",
              "font-weight": "700",
              "font-family": "var(--mz-font-sans)",
              "box-shadow": "0 2px 6px rgba(0,0,0,0.2)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 4px 10px rgba(0,0,0,0.25)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
            }}
          >
            <span>☕</span>
            <span>Buy Me a Coffee</span>
          </button>

          {/* Ko-fi */}
          <button
            onClick={() => void openExternalUrl(DONATION_KOFI_URL)}
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "8px",
              padding: "10px 20px",
              background: "#FF5E5B",
              color: "#fff",
              border: "none",
              "border-radius": "8px",
              cursor: "pointer",
              "font-size": "var(--mz-font-size-sm)",
              "font-weight": "700",
              "font-family": "var(--mz-font-sans)",
              "box-shadow": "0 2px 6px rgba(0,0,0,0.2)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 4px 10px rgba(0,0,0,0.25)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
            }}
          >
            <span>❤</span>
            <span>Ko-fi</span>
          </button>

          {/* PayPal */}
          <button
            onClick={() => void openExternalUrl(DONATION_PAYPAL_URL)}
            style={{
              display: "inline-flex",
              "align-items": "center",
              gap: "8px",
              padding: "10px 20px",
              background: "#0070ba",
              color: "#fff",
              border: "none",
              "border-radius": "8px",
              cursor: "pointer",
              "font-size": "var(--mz-font-size-sm)",
              "font-weight": "700",
              "font-family": "var(--mz-font-sans)",
              "box-shadow": "0 2px 6px rgba(0,0,0,0.2)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = "translateY(-1px)";
              e.currentTarget.style.boxShadow = "0 4px 10px rgba(0,0,0,0.25)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "0 2px 6px rgba(0,0,0,0.2)";
            }}
          >
            <span>💰</span>
            <span>PayPal</span>
          </button>
        </div>
      </div>

      {/* Version info */}
      <SettingSection title={t("settings.versionInfo")}>
        <div style={aboutRow}>
          <span style={{ color: "var(--mz-text-muted)" }}>{t("common.version")}</span>
          <span>{APP_VERSION}</span>
        </div>
        <div style={aboutRow}>
          <span style={{ color: "var(--mz-text-muted)" }}>{t("settings.releaseDate")}</span>
          <span>{APP_RELEASE_DATE}</span>
        </div>
        <div style={aboutRow}>
          <span style={{ color: "var(--mz-text-muted)" }}>{t("settings.framework")}</span>
          <span>Tauri 2.0 + SolidJS</span>
        </div>
        <div style={aboutRow}>
          <span style={{ color: "var(--mz-text-muted)" }}>{t("settings.editorEngine")}</span>
          <span>CodeMirror 6</span>
        </div>
        <div style={aboutRow}>
          <span style={{ color: "var(--mz-text-muted)" }}>{t("settings.platform")}</span>
          <span>Windows · macOS · Linux · iOS · Android</span>
        </div>
        <div style={aboutRow}>
          <span style={{ color: "var(--mz-text-muted)" }}>{t("settings.license")}</span>
          <span>AGPL-3.0-or-later</span>
        </div>
        <div style={aboutRow}>
          <span style={{ color: "var(--mz-text-muted)" }}>{t("settings.developer")}</span>
          <span>SuperJohn</span>
        </div>
      </SettingSection>

      {/* Features */}
      <SettingSection title={t("settings.features")}>
        <ul
          style={{
            "list-style": "none",
            padding: "0",
            margin: "0",
            display: "flex",
            "flex-direction": "column",
            gap: "6px",
            "font-size": "var(--mz-font-size-sm)",
            color: "var(--mz-text-secondary)",
            "line-height": "1.6",
          }}
        >
          <li>• {t("settings.feature.local")}</li>
          <li>• {t("settings.feature.ai")}</li>
          <li>• {t("settings.feature.cli")}</li>
          <li>• {t("settings.feature.sandbox")}</li>
          <li>• {t("settings.feature.tauri")}</li>
          <li>• {t("settings.feature.crossPlatform")}</li>
        </ul>
      </SettingSection>

      {/* Links */}
      <SettingSection title={t("settings.links")}>
        <div
          style={{
            display: "flex",
            "flex-wrap": "wrap",
            gap: "10px",
            "padding-top": "4px",
          }}
        >
          <AboutLinkButton
            icon="📦"
            label={t("settings.githubRepo")}
            onClick={() => void openExternalUrl(APP_REPO_URL)}
          />
          <AboutLinkButton
            icon="📖"
            label={t("settings.documentation")}
            onClick={() => void openExternalUrl(APP_DOCS_URL)}
          />
          <AboutLinkButton
            icon="🐛"
            label={t("settings.reportIssue")}
            onClick={() => void openExternalUrl(APP_ISSUE_URL)}
          />
          <AboutLinkButton
            icon="✨"
            label={t("settings.requestFeature")}
            onClick={() => void openExternalUrl(APP_ISSUE_URL)}
          />
          <AboutLinkButton
            icon="🔖"
            label={t("settings.changelog")}
            onClick={() => void openExternalUrl(APP_RELEASES_URL)}
          />
        </div>
      </SettingSection>

      {/* Acknowledgements */}
      <SettingSection title={t("settings.thanks")}>
        <p
          style={{
            "font-size": "var(--mz-font-size-sm)",
            color: "var(--mz-text-secondary)",
            "line-height": "1.6",
            margin: "0 0 12px 0",
          }}
        >
          {t("settings.thanksMessage")}
        </p>
        <div
          style={{
            "font-size": "var(--mz-font-size-xs)",
            color: "var(--mz-text-muted)",
          }}
        >
          {t("settings.openSourceLibraries")}:{" "}
          <span>Tauri · SolidJS · CodeMirror · tantivy · KaTeX · Mermaid · Shiki</span>
        </div>
      </SettingSection>
    </div>
  );
};

const AboutLinkButton: Component<{
  icon: string;
  label: string;
  onClick: () => void;
}> = (props) => (
  <button
    onClick={props.onClick}
    style={{
      display: "inline-flex",
      "align-items": "center",
      gap: "8px",
      padding: "8px 14px",
      background: "var(--mz-bg-tertiary)",
      border: "1px solid var(--mz-border)",
      "border-radius": "var(--mz-radius-md)",
      color: "var(--mz-text-primary)",
      cursor: "pointer",
      "font-size": "var(--mz-font-size-sm)",
      "font-family": "var(--mz-font-sans)",
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = "var(--mz-bg-hover)";
      e.currentTarget.style.borderColor = "var(--mz-accent)";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = "var(--mz-bg-tertiary)";
      e.currentTarget.style.borderColor = "var(--mz-border)";
    }}
  >
    <span>{props.icon}</span>
    <span>{props.label}</span>
  </button>
);

const AiApiKeyInput: Component<{
  label: string;
  description?: string;
  value: string;
  visible: boolean;
  placeholder?: string;
  width?: string;
  onChange: (value: string) => void;
  onToggleVisible: () => void;
}> = (props) => (
  <div style={settingsRowStyle}>
    <div style={{ flex: "1" }}>
      <div style={settingsLabelStyle}>{props.label}</div>
      <Show when={props.description}>
        <div style={settingsDescStyle}>{props.description}</div>
      </Show>
    </div>
    <div
      style={{
        display: "flex",
        "align-items": "center",
        width: props.width || "220px",
        border: "1px solid var(--mz-border)",
        "border-radius": "var(--mz-radius-sm)",
        background: "var(--mz-bg-primary)",
        "flex-shrink": "0",
      }}
    >
      <input
        type={props.visible ? "text" : "password"}
        value={props.value}
        placeholder={props.placeholder}
        onInput={(event) => props.onChange(event.currentTarget.value)}
        style={{
          ...settingsInputBareStyle,
          flex: "1",
          width: "0",
          border: "none",
          background: "transparent",
        }}
      />
      <button
        type="button"
        title={props.visible ? t("settings.aiHideApiKey") : t("settings.aiShowApiKey")}
        aria-label={props.visible ? t("settings.aiHideApiKey") : t("settings.aiShowApiKey")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onToggleVisible}
        style={{
          width: "32px",
          height: "28px",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          border: "none",
          background: "transparent",
          color: "var(--mz-text-muted)",
          cursor: "pointer",
          "flex-shrink": "0",
        }}
      >
        <Show when={props.visible} fallback={<Eye size={16} />}>
          <EyeOff size={16} />
        </Show>
      </button>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const titleStyle = {
  "font-size": "1.3em",
  "font-weight": "700",
  color: "var(--mz-text-primary)",
  "margin-bottom": "20px",
};

const titleActionRowStyle = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "12px",
  "margin-bottom": "20px",
} as const;

const titleSelectStyle = {
  width: "180px",
  padding: "4px 8px",
  border: "1px solid var(--mz-border)",
  "border-radius": "var(--mz-radius-sm)",
  background: "var(--mz-bg-primary)",
  color: "var(--mz-text-primary)",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
  cursor: "pointer",
} as const;

const sectionTitleStyle = {
  "font-size": "var(--mz-font-size-sm)",
  "font-weight": "600",
  color: "var(--mz-text-muted)",
  "text-transform": "uppercase",
  "letter-spacing": "0.5px",
  "margin-bottom": "12px",
  "padding-bottom": "6px",
  "border-bottom": "1px solid var(--mz-border)",
} as const;

const aboutRow = {
  display: "flex",
  "justify-content": "space-between",
  padding: "6px 0",
  "font-size": "var(--mz-font-size-sm)",
  color: "var(--mz-text-primary)",
};

const settingsButtonStyle = {
  border: "1px solid var(--mz-border)",
  background: "var(--mz-bg-primary)",
  color: "var(--mz-text-primary)",
  "border-radius": "var(--mz-radius-sm)",
  padding: "5px 10px",
  cursor: "pointer",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
};

const settingsDangerButtonStyle = {
  ...settingsButtonStyle,
  color: "var(--mz-error)",
};

const settingsRowStyle = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  padding: "8px 0",
  gap: "16px",
  "min-height": "40px",
};

const settingsLabelStyle = {
  "font-size": "var(--mz-font-size-sm)",
  color: "var(--mz-text-primary)",
  "font-weight": "500",
};

const settingsDescStyle = {
  "font-size": "var(--mz-font-size-xs)",
  color: "var(--mz-text-muted)",
  "margin-top": "2px",
};

const settingsInputBareStyle = {
  padding: "4px 8px",
  color: "var(--mz-text-primary)",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
  outline: "none",
};

const aiPromptTextareaStyle = {
  width: "min(520px, 100%)",
  "box-sizing": "border-box",
  height: "120px",
  resize: "vertical",
  padding: "8px 10px",
  border: "1px solid var(--mz-border)",
  "border-radius": "var(--mz-radius-sm)",
  background: "var(--mz-bg-primary)",
  color: "var(--mz-text-primary)",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
  outline: "none",
  "line-height": "1.5",
  "flex-shrink": "0",
} as const;

const aiSkillEditorStyle = {
  width: "min(520px, 100%)",
  "box-sizing": "border-box",
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  "flex-shrink": "0",
} as const;

const aiSkillInputStyle = {
  width: "100%",
  "box-sizing": "border-box",
  border: "1px solid var(--mz-border)",
  "border-radius": "var(--mz-radius-sm)",
  background: "var(--mz-bg-primary)",
} as const;

const aiSkillTextareaStyle = {
  ...aiPromptTextareaStyle,
  width: "100%",
  height: "96px",
} as const;

const aiSkillListStyle = {
  display: "flex",
  "flex-direction": "column",
  gap: "8px",
  "margin-top": "12px",
} as const;

const aiSkillRowStyle = {
  display: "flex",
  "flex-wrap": "wrap",
  "align-items": "flex-start",
  "justify-content": "space-between",
  gap: "12px",
  padding: "10px 0",
  "border-top": "1px solid var(--mz-border)",
} as const;

const aiSkillPreviewStyle = {
  "font-size": "var(--mz-font-size-xs)",
  color: "var(--mz-text-muted)",
  "margin-top": "4px",
  "white-space": "nowrap",
  overflow: "hidden",
  "text-overflow": "ellipsis",
  "max-width": "52vw",
} as const;

const aiVoiceExportInputStyle = {
  width: "min(360px, 40vw)",
  "box-sizing": "border-box",
  border: "1px solid var(--mz-border)",
  "border-radius": "var(--mz-radius-sm)",
  background: "var(--mz-bg-primary)",
} as const;

// ---------------------------------------------------------------------------
// Plugin Settings Panel — renders a plugin's PluginSettingTab
// ---------------------------------------------------------------------------

const PluginSettingsPanel: Component<{ pluginId: string }> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  const [pluginInfo, setPluginInfo] = createSignal<PluginInfoFE | null>(null);
  // Track whether the custom settings tab has been rendered into the container
  const [settingsRendered, setSettingsRendered] = createSignal(false);

  // Reactive: re-evaluate when pluginsVersion changes (after plugin load/reload)
  const hasCustomTab = () => {
    pluginsVersion(); // read the signal so SolidJS tracks it
    return !!getPluginSettingTab(props.pluginId);
  };

  /**
   * Render the plugin's custom settings tab into containerRef.
   * Called from onMount and also re-called when plugins reload.
   */
  async function renderSettingsTab() {
    if (!containerRef) return;
    const settingTab = getPluginSettingTab(props.pluginId);
    if (!settingTab) return;

    // Plugin has a custom settings tab — render it.
    settingTab.containerEl.innerHTML = "";
    try {
      const result = settingTab.display();
      // Await if display() returns a promise (async display methods)
      if (result && typeof result.then === "function") {
        await result;
      }
    } catch (e) {
      console.error(`[PluginSettings] display() error for "${props.pluginId}":`, e);
    }
    Object.assign(settingTab.containerEl.style, {
      width: "100%",
      "box-sizing": "border-box",
      display: "block",
    });
    // Avoid duplicate appends — clear first
    if (containerRef.contains(settingTab.containerEl)) {
      containerRef.removeChild(settingTab.containerEl);
    }
    containerRef.appendChild(settingTab.containerEl);
    setSettingsRendered(true);
  }

  onMount(async () => {
    (window as any).__mindzj_plugin_settings_active_tab = {
      id: props.pluginId,
      containerEl: containerRef,
    };

    // Fetch plugin info for the default page
    try {
      const plugins = await invoke<PluginInfoFE[]>("list_plugins");
      const found = plugins.find(p => p.manifest.id === props.pluginId);
      if (found) setPluginInfo(found);
    } catch {}

    // Initial render of settings tab
    await renderSettingsTab();
  });

  // Re-render settings when pluginsVersion changes (e.g. after plugin reload)
  createEffect(() => {
    const _ver = pluginsVersion(); // track reactive dependency
    // Skip the initial run — onMount handles that
    if (_ver === 0) return;
    // Re-render if the tab is available and container exists
    if (containerRef && getPluginSettingTab(props.pluginId)) {
      renderSettingsTab();
    }
  });

  onCleanup(() => {
    if ((window as any).__mindzj_plugin_settings_active_tab?.id === props.pluginId) {
      (window as any).__mindzj_plugin_settings_active_tab = null;
    }
    const settingTab = getPluginSettingTab(props.pluginId);
    if (settingTab && typeof settingTab.hide === "function") {
      try { settingTab.hide(); } catch {}
    }
  });

  const infoRowStyle = {
    display: "flex", "justify-content": "space-between", "align-items": "center",
    padding: "10px 0", "border-bottom": "1px solid var(--mz-border)",
    "font-size": "var(--mz-font-size-sm)",
  };

  return (
    <div style={{ "font-size": "var(--mz-font-size-sm)", color: "var(--mz-text-primary)", width: "100%", "min-height": "0" }}>
      {/* Default plugin info page (shown for ALL plugins, above custom settings) */}
      <Show when={pluginInfo()}>
        {(info) => (
          <div style={{ "margin-bottom": hasCustomTab() ? "24px" : "0" }}>
            <SettingSection title={t("settings.pluginInfo")}>
              <div style={infoRowStyle}>
                <span style={{ color: "var(--mz-text-muted)" }}>{t("settings.pluginId")}</span>
                <span style={{ "font-family": "var(--mz-font-mono)", "font-size": "var(--mz-font-size-xs)" }}>
                  {info().manifest.id}
                </span>
              </div>
              <div style={infoRowStyle}>
                <span style={{ color: "var(--mz-text-muted)" }}>{t("common.version")}</span>
                <span>{info().manifest.version}</span>
              </div>
              <div style={infoRowStyle}>
                <span style={{ color: "var(--mz-text-muted)" }}>{t("common.author")}</span>
                <span>{info().manifest.author || t("common.unknown")}</span>
              </div>
              <Show when={info().manifest.description}>
                <div style={infoRowStyle}>
                  <span style={{ color: "var(--mz-text-muted)" }}>{t("common.description")}</span>
                  <span style={{ "text-align": "right", "max-width": "60%", "word-break": "break-word" }}>
                    {info().manifest.description}
                  </span>
                </div>
              </Show>
              <div style={infoRowStyle}>
                <span style={{ color: "var(--mz-text-muted)" }}>{t("settings.dataDirectory")}</span>
                <span style={{ "font-family": "var(--mz-font-mono)", "font-size": "var(--mz-font-size-xs)" }}>
                  .mindzj/plugins/{info().dir_path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}/
                </span>
              </div>
            </SettingSection>

            <SettingSection title={t("settings.actions")}>
              <div style={{ display: "flex", gap: "8px", padding: "8px 0" }}>
                <button
                  onClick={async () => {
                    try {
                      await pluginStore.reloadPlugin(props.pluginId);
                      // Re-fetch info after reload
                      const plugins = await invoke<PluginInfoFE[]>("list_plugins");
                      const found = plugins.find(p => p.manifest.id === props.pluginId);
                      if (found) setPluginInfo(found);
                    } catch (e) {
                      console.error("Reload failed:", e);
                    }
                  }}
                  style={{
                    padding: "6px 16px", border: "1px solid var(--mz-border)",
                    "border-radius": "var(--mz-radius-sm)", background: "var(--mz-bg-primary)",
                    color: "var(--mz-text-primary)", cursor: "pointer",
                    "font-size": "var(--mz-font-size-sm)", "font-family": "var(--mz-font-sans)",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--mz-accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--mz-border)"; }}
                >
                  {t("settings.reloadPlugin")}
                </button>
                <button
                  onClick={async () => {
                    try {
                      await invoke("open_path_in_file_manager", {
                        absolutePath: info().dir_path,
                      });
                    } catch (e) {
                      console.error("Open folder failed:", e);
                    }
                  }}
                  style={{
                    padding: "6px 16px", border: "1px solid var(--mz-border)",
                    "border-radius": "var(--mz-radius-sm)", background: "var(--mz-bg-primary)",
                    color: "var(--mz-text-primary)", cursor: "pointer",
                    "font-size": "var(--mz-font-size-sm)", "font-family": "var(--mz-font-sans)",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--mz-accent)"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--mz-border)"; }}
                >
                  {t("settings.openPluginFolder")}
                </button>
              </div>
            </SettingSection>
          </div>
        )}
      </Show>

      {/* Plugin settings container — always present so containerRef is set before onMount.
          The SettingSection heading is shown only when a custom tab exists. */}
      <Show when={hasCustomTab() || settingsRendered()}>
        <SettingSection title={t("settings.pluginSettings")}>
          <div ref={containerRef} />
        </SettingSection>
      </Show>
      <Show when={!hasCustomTab() && !settingsRendered()}>
        <div ref={el => { containerRef = el; }} />
      </Show>
    </div>
  );
};

// ---------------------------------------------------------------------------
// CSS Snippets Panel — Obsidian-style user stylesheet manager
// ---------------------------------------------------------------------------
//
// Renders the list of user CSS snippets with per-snippet name, enabled
// toggle, code textarea, and a delete button, plus an "add snippet"
// button. Any change is persisted via `settingsStore.updateSetting` and
// applied to the DOM by the reactive effect in settings.ts (which owns a
// single <style id="mz-user-css-snippets"> element).

// File-based CSS snippets panel. Reads `.css` files from the vault's
// `.mindzj/snippets/` folder (via Rust commands) and lets the user
// toggle which ones are enabled. Enabled file names are persisted in
// `settings.enabled_css_snippets`; the settings store's reactive effect
// fetches and injects their contents as a `<style>` element so edits
// apply live.
const CssSnippetsPanel: Component = () => {
  const [snippetFiles, setSnippetFiles] = createSignal<string[]>([]);
  const [selectedSnippet, setSelectedSnippet] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [loadingSnippet, setLoadingSnippet] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [dirty, setDirty] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  const s = () => settingsStore.settings();
  const enabled = () => new Set(s().enabled_css_snippets ?? []);
  const snippetsDir = ".mindzj/snippets";
  const snippetPath = (name: string) => `${snippetsDir}/${name}`;

  function normalizeSnippetName(value: string) {
    const leaf = value.trim().replace(/\\/g, "/").split("/").pop() ?? "";
    const safe = leaf.replace(/[<>:"/\\|?*]+/g, "-").trim();
    if (!safe) return "";
    return safe.toLowerCase().endsWith(".css") ? safe : `${safe}.css`;
  }

  async function loadSnippet(name: string) {
    setSelectedSnippet(name);
    setLoadingSnippet(true);
    setSaveError(null);
    try {
      const content = await invoke<string>("read_css_snippet", { name });
      setDraft(content);
      setDirty(false);
    } catch (e) {
      console.error("[css-snippets] read failed:", e);
      setDraft("");
    } finally {
      setLoadingSnippet(false);
    }
  }

  async function refresh(preferredName: string | null = selectedSnippet()) {
    setLoading(true);
    try {
      const names = await invoke<string[]>("list_css_snippets");
      setSnippetFiles(names);
      // Prune enabled list to names that actually exist on disk.
      const existing = new Set(names);
      const cur = s().enabled_css_snippets ?? [];
      const pruned = cur.filter((n) => existing.has(n));
      if (pruned.length !== cur.length) {
        await settingsStore.updateSetting("enabled_css_snippets", pruned);
        reloadCssSnippets();
      }
      const nextSelected =
        preferredName && existing.has(preferredName)
          ? preferredName
          : names[0] ?? null;
      if (!nextSelected) {
        setSelectedSnippet(null);
        setDraft("");
        setDirty(false);
        setSaveError(null);
      } else if (nextSelected !== selectedSnippet()) {
        await loadSnippet(nextSelected);
      } else if (!draft() && !dirty()) {
        await loadSnippet(nextSelected);
      }
    } catch (e) {
      console.error("[css-snippets] list failed:", e);
    } finally {
      setLoading(false);
    }
  }

  onMount(() => { void refresh(); });

  async function toggleSnippet(name: string, on: boolean) {
    const cur = s().enabled_css_snippets ?? [];
    const next = on
      ? Array.from(new Set([...cur, name]))
      : cur.filter((n) => n !== name);
    await settingsStore.updateSetting("enabled_css_snippets", next);
    reloadCssSnippets();
  }

  async function saveSnippet() {
    const name = selectedSnippet();
    if (!name || !dirty()) return true;

    setSaving(true);
    setSaveError(null);
    try {
      await invoke("write_file", {
        relativePath: snippetPath(name),
        content: draft(),
      });
      setDirty(false);
      reloadCssSnippets();
      await refresh(name);
      return true;
    } catch (e: any) {
      console.error("[css-snippets] save failed:", e);
      setSaveError(e?.message || t("common.unknown"));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function selectSnippet(name: string) {
    if (selectedSnippet() === name) return;
    if (dirty() && !(await saveSnippet())) {
      return;
    }
    await loadSnippet(name);
  }

  async function createSnippet() {
    if (dirty() && !(await saveSnippet())) {
      return;
    }
    const rawName = await promptDialog(t("settings.newSnippetPrompt"), "snippet.css");
    const name = normalizeSnippetName(rawName || "");
    if (!name) return;

    try {
      await invoke("create_dir", { relativePath: snippetsDir }).catch(() => {});
      try {
        await invoke("create_file", {
          relativePath: snippetPath(name),
          content: "/* CSS snippet */\n",
        });
      } catch {
        // If the file already exists we just select it below.
      }
      await refresh(name);
      await loadSnippet(name);
    } catch (e) {
      console.error("[css-snippets] create failed:", e);
    }
  }

  async function deleteSnippet() {
    const name = selectedSnippet();
    if (!name) return;
    const confirmed = await confirmDialog(t("settings.deleteSnippetConfirm", { name }));
    if (!confirmed) return;

    try {
      await invoke("delete_file", { relativePath: snippetPath(name) });
      const nextEnabled = (s().enabled_css_snippets ?? []).filter((entry) => entry !== name);
      await settingsStore.updateSetting("enabled_css_snippets", nextEnabled);
      reloadCssSnippets();
      setSelectedSnippet(null);
      setDraft("");
      setDirty(false);
      setSaveError(null);
      await refresh();
    } catch (e) {
      console.error("[css-snippets] delete failed:", e);
    }
  }

  async function openFolder() {
    try {
      const dir = await invoke<string>("get_snippets_dir");
      // Use the Tauri shell plugin to reveal the folder in the OS file
      // manager. Opening a directory path works on Windows, macOS, Linux.
      const shell = await import("@tauri-apps/plugin-shell");
      await shell.open(dir);
    } catch (e) {
      console.error("[css-snippets] openFolder failed:", e);
    }
  }

  return (
    <div style={{ "margin-top": "24px" }}>
      {/* Heading + description + action-button row all stacked on
          their own lines. Previously the heading/description was a
          flex sibling of the button row, which meant long-locale
          translations (German / French) got squeezed into a narrow
          column next to the buttons and wrapped awkwardly. Stacking
          them vertically removes the horizontal-space competition
          entirely — same fix as applied to the custom-skins panel. */}
      <div
        style={{
          display: "flex",
          "flex-direction": "column",
          gap: "8px",
          "margin-bottom": "12px",
        }}
      >
        <h3 style={sectionTitleStyle}>
          {t("settings.cssSnippets")}
        </h3>
        <p
          style={{
            "font-size": "var(--mz-font-size-xs)",
            color: "var(--mz-text-muted)",
            margin: "0",
            "line-height": "1.5",
          }}
        >
          {t("settings.cssSnippetsDescription.start")} <code>.mindzj/snippets/</code>
          {t("settings.cssSnippetsDescription.middle")} "{t("common.reload")}"
          {t("settings.cssSnippetsDescription.end")}
        </p>
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap", "margin-top": "4px" }}>
          <button
            onClick={() => { void createSnippet(); }}
            title={t("settings.newSnippet")}
            style={snippetBtnPrimary}
          >
            {t("settings.newSnippet")}
          </button>
          <button
            onClick={openFolder}
            title={t("settings.openSnippetsFolder")}
            style={snippetBtnSecondary}
            onMouseEnter={(e) => (e.currentTarget.style.background = "var(--mz-bg-hover)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {t("common.openFolder")}
          </button>
          <button
            onClick={() => { void refresh(); reloadCssSnippets(); }}
            title={t("settings.reloadSnippets")}
            style={snippetBtnPrimary}
          >
            {t("common.reload")}
          </button>
        </div>
      </div>

      <Show
        when={!loading()}
        fallback={
          <div style={snippetEmptyStyle}>{t("settings.loadingSnippets")}</div>
        }
      >
        <div
          style={{
            display: "flex",
            gap: "16px",
            "flex-wrap": "wrap",
          }}
        >
          <div
            style={{
              flex: "0 0 280px",
              width: "280px",
              "max-width": "100%",
            }}
          >
            <Show
              when={snippetFiles().length > 0}
              fallback={
                <div style={snippetEmptyStyle}>
                  <div>{t("settings.noSnippetFiles")}</div>
                  <div style={{ "margin-top": "8px", "font-size": "var(--mz-font-size-xs)" }}>
                    {t("settings.noSnippetFilesHint")}
                  </div>
                </div>
              }
            >
              <For each={snippetFiles()}>
                {(name) => {
                  const isOn = () => enabled().has(name);
                  const isSelected = () => selectedSnippet() === name;
                  return (
                    <button
                      onClick={() => { void selectSnippet(name); }}
                      style={{
                        ...snippetCardStyle,
                        ...(isSelected() ? snippetCardSelectedStyle : {}),
                      }}
                    >
                      <div style={{ "min-width": "0", flex: "1", "text-align": "left" }}>
                        <div
                          title={name}
                          style={{
                            "font-family": "var(--mz-font-mono)",
                            "font-size": "var(--mz-font-size-sm)",
                            color: "var(--mz-text-primary)",
                            overflow: "hidden",
                            "text-overflow": "ellipsis",
                            "white-space": "nowrap",
                          }}
                        >
                          {name}
                        </div>
                      </div>
                      <label
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "6px",
                          cursor: "pointer",
                          "font-size": "var(--mz-font-size-sm)",
                          color: "var(--mz-text-secondary)",
                          "user-select": "none",
                        }}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={isOn()}
                          onChange={(e) => void toggleSnippet(name, e.currentTarget.checked)}
                          style={{ "accent-color": "var(--mz-accent)", cursor: "pointer" }}
                        />
                        {t("common.enable")}
                      </label>
                    </button>
                  );
                }}
              </For>
            </Show>
          </div>

          <div style={{ flex: "1 1 360px", "min-width": "280px" }}>
            <Show
              when={selectedSnippet()}
              fallback={
                <div style={snippetEmptyStyle}>{t("settings.selectSnippetToEdit")}</div>
              }
            >
              {(name) => (
                <div
                  style={{
                    border: "1px solid var(--mz-border)",
                    "border-radius": "var(--mz-radius-md)",
                    background: "var(--mz-bg-primary)",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      gap: "12px",
                      padding: "12px 14px",
                      "border-bottom": "1px solid var(--mz-border)",
                      background: "var(--mz-bg-secondary)",
                    }}
                  >
                    <div style={{ "min-width": "0", flex: "1" }}>
                      <div
                        style={{
                          "font-family": "var(--mz-font-mono)",
                          "font-size": "var(--mz-font-size-sm)",
                          color: "var(--mz-text-primary)",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                        }}
                      >
                        {name()}
                      </div>
                      <div
                        style={{
                          "font-size": "var(--mz-font-size-xs)",
                          color: "var(--mz-text-muted)",
                          "margin-top": "4px",
                        }}
                      >
                        {t("settings.cssSnippetEditorHint")}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: "8px", "flex-shrink": "0" }}>
                      <button
                        onClick={() => { void saveSnippet(); }}
                        disabled={!dirty() || saving()}
                        style={{
                          ...snippetBtnPrimary,
                          opacity: !dirty() || saving() ? "0.6" : "1",
                          cursor: !dirty() || saving() ? "default" : "pointer",
                        }}
                      >
                        {saving() ? t("common.loading") : t("common.save")}
                      </button>
                      <button
                        onClick={() => { void deleteSnippet(); }}
                        style={snippetBtnDanger}
                      >
                        {t("common.delete")}
                      </button>
                    </div>
                  </div>

                  <Show
                    when={!loadingSnippet()}
                    fallback={<div style={snippetEmptyStyle}>{t("common.loading")}</div>}
                  >
                    <textarea
                      value={draft()}
                      spellcheck={false}
                      onInput={(event) => {
                        setDraft(event.currentTarget.value);
                        setDirty(true);
                        setSaveError(null);
                      }}
                      style={snippetTextareaStyle}
                    />
                  </Show>

                  <Show when={saveError()}>
                    {(message) => (
                      <div
                        style={{
                          padding: "10px 14px",
                          color: "var(--mz-error)",
                          "font-size": "var(--mz-font-size-xs)",
                          "border-top": "1px solid var(--mz-border)",
                          background: "var(--mz-bg-secondary)",
                        }}
                      >
                        {message()}
                      </div>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

const snippetBtnPrimary = {
  padding: "6px 12px",
  border: "1px solid var(--mz-accent)",
  background: "var(--mz-accent)",
  color: "var(--mz-text-on-accent)",
  "border-radius": "var(--mz-radius-sm)",
  cursor: "pointer",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
};

const snippetBtnSecondary = {
  padding: "6px 12px",
  border: "1px solid var(--mz-border)",
  background: "transparent",
  color: "var(--mz-text-primary)",
  "border-radius": "var(--mz-radius-sm)",
  cursor: "pointer",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
};

const snippetBtnDanger = {
  padding: "6px 12px",
  border: "1px solid var(--mz-error)",
  background: "transparent",
  color: "var(--mz-error)",
  "border-radius": "var(--mz-radius-sm)",
  cursor: "pointer",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
};

const snippetCardStyle = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  gap: "12px",
  width: "100%",
  padding: "10px 14px",
  border: "1px solid var(--mz-border)",
  "border-radius": "var(--mz-radius-md)",
  "margin-bottom": "8px",
  background: "var(--mz-bg-primary)",
  cursor: "pointer",
};

const snippetCardSelectedStyle = {
  border: "1px solid var(--mz-accent)",
  background: "var(--mz-accent-subtle)",
};

const snippetEmptyStyle = {
  padding: "24px",
  "text-align": "center" as const,
  color: "var(--mz-text-muted)",
  "font-size": "var(--mz-font-size-sm)",
  border: "1px dashed var(--mz-border)",
  "border-radius": "var(--mz-radius-md)",
};

const snippetTextareaStyle = {
  width: "100%",
  "min-height": "320px",
  resize: "vertical" as const,
  border: "none",
  outline: "none",
  padding: "14px",
  background: "var(--mz-bg-primary)",
  color: "var(--mz-text-primary)",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-mono)",
  "line-height": "1.6",
};

// ---------------------------------------------------------------------------
// Skin (theme) picker panel
// ---------------------------------------------------------------------------
//
// Replaces the original 3-button light/dark/system row. Lists every
// built-in preset from `styles/themes/index.ts` as a swatch card, plus
// one card per `.mindzj/themes/*.css` file the user has imported into
// the current vault. Below the grid sits a row of actions that let
// the user import a new theme from disk, scaffold a blank theme file,
// open the themes folder in the OS file manager, reload the currently
// active custom skin (after editing it externally), and delete
// imported themes.
//
// The whole panel is per-vault because `settings.theme` lives in
// `.mindzj/settings.json`. Switching vaults via `open_vault_window`
// carries the active skin into the new window automatically.

const SYSTEM_SKIN: BuiltInSkin = {
  id: "system",
  label: "System",
  mode: "dark",
  swatch: ["#1e1e1e", "#ffffff"],
};

const SkinPickerPanel: Component = () => {
  const [customThemes, setCustomThemes] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Transient success banner (e.g. "Reloaded"). Cleared automatically
  // after a couple seconds so the user always sees a confirmation when
  // an async action completes without becoming noisy over time.
  const [notice, setNotice] = createSignal<string | null>(null);
  createEffect(() => {
    const msg = notice();
    if (!msg) return;
    const timer = window.setTimeout(() => setNotice(null), 2400);
    onCleanup(() => window.clearTimeout(timer));
  });

  // Normalize the raw filename list into bare names without the `.css`
  // extension so downstream UI doesn't have to trim repeatedly.
  const customNames = createMemo(() =>
    customThemes().map((fn) => fn.replace(/\.css$/i, "")),
  );

  async function refresh() {
    setLoading(true);
    try {
      const names = await invoke<string[]>("list_themes");
      setCustomThemes(names);
    } catch (e: any) {
      console.error("[skin] list_themes failed:", e);
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  onMount(() => { void refresh(); });

  function applySkin(id: string) {
    settingsStore.updateSetting("theme", id);
  }

  async function importTheme() {
    setError(null);
    try {
      const selected = await dialogOpen({
        multiple: false,
        directory: false,
        filters: [{ name: "CSS", extensions: ["css"] }],
        title: t("settings.skinImportDialogTitle"),
      });
      if (!selected || typeof selected !== "string") return;
      setBusy(true);
      // overwrite=true so re-importing an existing filename just updates it.
      const fileName = await invoke<string>("import_theme", {
        sourceAbsolutePath: selected,
        overwrite: true,
      });
      const stem = fileName.replace(/\.css$/i, "");
      await refresh();
      applySkin(`${CUSTOM_SKIN_PREFIX}${stem}`);
    } catch (e: any) {
      console.error("[skin] import_theme failed:", e);
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function createEmptyTheme() {
    setError(null);
    const raw = await promptDialog(t("settings.skinNewPrompt"), "my-theme");
    if (!raw) return;
    const stem = raw.trim().replace(/\.css$/i, "").replace(/[^\w.-]+/g, "-");
    if (!stem) return;
    setBusy(true);
    try {
      const fileName = await invoke<string>("write_theme", {
        bareName: stem,
        content: SKIN_STARTER_CSS,
      });
      await refresh();
      const bare = fileName.replace(/\.css$/i, "");
      applySkin(`${CUSTOM_SKIN_PREFIX}${bare}`);
    } catch (e: any) {
      console.error("[skin] write_theme failed:", e);
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function openFolder() {
    setError(null);
    try {
      const dir = await invoke<string>("get_themes_dir");
      // Use the existing `open_path_in_file_manager` command rather
      // than `shell.open()` because on Windows the path returned by
      // `get_themes_dir` carries the `\\?\` extended-length prefix
      // (`Vault::open` canonicalizes the root), which `ShellExecuteW`
      // under `shell.open()` can't parse. The Rust command already
      // strips that prefix before spawning `explorer.exe`, so going
      // through it is the robust cross-platform path.
      await invoke("open_path_in_file_manager", { absolutePath: dir });
    } catch (e: any) {
      console.error("[skin] openFolder failed:", e);
      setError(String(e?.message ?? e));
    }
  }

  async function deleteCustom(stem: string) {
    const confirmed = await confirmDialog(
      t("settings.skinDeleteConfirm", { name: stem }),
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await invoke("delete_theme", { name: `${stem}.css` });
      // If the user deleted the active skin, fall back to the default.
      const active = settingsStore.settings().theme;
      if (active === `${CUSTOM_SKIN_PREFIX}${stem}`) {
        applySkin("dark");
      }
      await refresh();
    } catch (e: any) {
      console.error("[skin] delete_theme failed:", e);
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function reloadActive() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      // Re-scan the themes folder on disk (picks up files the user
      // dropped in manually) and re-read the currently-active custom
      // skin so any external edits to its .css file become visible
      // without restarting the app.
      await refresh();
      await settingsStore.reloadCustomSkin();
      setNotice(t("settings.skinReloadDone"));
    } catch (e: any) {
      console.error("[skin] reload failed:", e);
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const active = () => settingsStore.settings().theme;

  // Split the preset catalogue into dark vs. light buckets so the
  // picker renders two clearly-labelled sections. We do this at memo
  // scope so the filter only runs when `BUILT_IN_SKINS` changes (i.e.
  // never, in practice) rather than on every render.
  const darkSkins = createMemo(() =>
    BUILT_IN_SKINS.filter((s) => s.mode === "dark"),
  );
  const lightSkins = createMemo(() =>
    BUILT_IN_SKINS.filter((s) => s.mode === "light"),
  );

  const gridStyle = {
    display: "grid",
    "grid-template-columns": "repeat(auto-fill, minmax(170px, 1fr))",
    gap: "8px",
  } as const;
  const groupHeaderStyle = {
    "font-size": "var(--mz-font-size-xs)",
    color: "var(--mz-text-muted)",
    "text-transform": "uppercase" as const,
    "letter-spacing": "0.06em",
    "font-weight": "600",
    "margin-top": "4px",
  };

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "12px", padding: "8px 0" }}>
      {/* System skin — listed on its own row so it's never mistaken for
          a specific preset. Clicking it hands control to the OS's
          `prefers-color-scheme` so the user can flip light/dark from
          the system menu. */}
      <div style={gridStyle}>
        <SkinCard
          skin={SYSTEM_SKIN}
          active={active() === "system"}
          onSelect={() => applySkin("system")}
        />
      </div>

      {/* Dark presets */}
      <div style={groupHeaderStyle}>{t("settings.skinGroupDark")}</div>
      <div style={gridStyle}>
        <For each={darkSkins()}>
          {(skin) => (
            <SkinCard
              skin={skin}
              active={active() === skin.id}
              onSelect={() => applySkin(skin.id)}
            />
          )}
        </For>
      </div>

      {/* Light presets */}
      <div style={groupHeaderStyle}>{t("settings.skinGroupLight")}</div>
      <div style={gridStyle}>
        <For each={lightSkins()}>
          {(skin) => (
            <SkinCard
              skin={skin}
              active={active() === skin.id}
              onSelect={() => applySkin(skin.id)}
            />
          )}
        </For>
      </div>

      {/* Custom themes section.
          The heading, the description paragraph and the action-button
          row each live on their own line. Previously the heading/desc
          block was a flex sibling of the button row which meant that
          in long-locale translations (German / French) the description
          got squeezed into a narrow column next to the buttons and
          wrapped awkwardly — so much so that the heading and
          description sometimes overlapped visually. Stacking the three
          pieces vertically removes the competition for horizontal
          space entirely. */}
      <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "margin-top": "8px" }}>
        <div style={groupHeaderStyle}>
          {t("settings.customSkinsSection")}
        </div>
        <p style={{
          "font-size": "var(--mz-font-size-xs)",
          color: "var(--mz-text-muted)",
          margin: "0",
          "line-height": "1.5",
        }}>
          {t("settings.customSkinsDescription")}
        </p>
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap", "margin-top": "4px" }}>
          <button
            onClick={() => { void importTheme(); }}
            disabled={busy()}
            style={skinBtnPrimary(busy())}
          >
            {t("settings.skinImport")}
          </button>
          <button
            onClick={() => { void createEmptyTheme(); }}
            disabled={busy()}
            style={skinBtnSecondary(busy())}
          >
            {t("settings.skinNew")}
          </button>
          <button
            onClick={() => { void openFolder(); }}
            disabled={busy()}
            style={skinBtnSecondary(busy())}
            onMouseEnter={(e) => {
              if (!busy()) e.currentTarget.style.background = "var(--mz-bg-hover)";
            }}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {t("common.openFolder")}
          </button>
          <button
            onClick={() => { void reloadActive(); }}
            disabled={busy()}
            style={skinBtnSecondary(busy())}
            onMouseEnter={(e) => {
              if (!busy()) e.currentTarget.style.background = "var(--mz-bg-hover)";
            }}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            {t("common.reload")}
          </button>
        </div>
      </div>

      <Show when={!loading()} fallback={
        <div style={snippetEmptyStyle}>{t("settings.loadingThemes")}</div>
      }>
        <Show when={customNames().length > 0} fallback={
          <div style={snippetEmptyStyle}>
            <div>{t("settings.noCustomSkins")}</div>
            <div style={{ "margin-top": "8px", "font-size": "var(--mz-font-size-xs)" }}>
              {t("settings.noCustomSkinsHint")}
            </div>
          </div>
        }>
          <div style={{
            display: "grid",
            "grid-template-columns": "repeat(auto-fill, minmax(180px, 1fr))",
            gap: "8px",
          }}>
            <For each={customNames()}>
              {(stem) => {
                const id = `${CUSTOM_SKIN_PREFIX}${stem}`;
                const isActive = () => active() === id;
                return (
                  <div
                    style={{
                      ...skinCardStyleBase,
                      ...(isActive() ? skinCardStyleActive : {}),
                      position: "relative",
                    }}
                  >
                    <button
                      onClick={() => applySkin(id)}
                      title={t("settings.skinApply")}
                      style={{
                        display: "flex",
                        "align-items": "center",
                        gap: "8px",
                        padding: "0",
                        margin: "0",
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        color: "var(--mz-text-primary)",
                        "text-align": "left",
                        flex: "1",
                        "min-width": "0",
                      }}
                    >
                      {/* Muted swatch — we don't know the colors without
                          parsing the CSS, so render a neutral tile. */}
                      <span style={{
                        display: "inline-flex",
                        width: "32px",
                        height: "28px",
                        "border-radius": "var(--mz-radius-sm)",
                        border: "1px solid var(--mz-border)",
                        background: "repeating-linear-gradient(45deg, var(--mz-bg-hover) 0 4px, var(--mz-bg-active) 4px 8px)",
                        "flex-shrink": "0",
                      }} />
                      <div style={{ "min-width": "0", flex: "1" }}>
                        <div style={{
                          "font-family": "var(--mz-font-mono)",
                          "font-size": "var(--mz-font-size-sm)",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                          "white-space": "nowrap",
                          color: isActive() ? "var(--mz-accent)" : "var(--mz-text-primary)",
                          "font-weight": isActive() ? "600" : "400",
                        }}>
                          {stem}
                        </div>
                        <div style={{
                          "font-size": "var(--mz-font-size-xs)",
                          color: "var(--mz-text-muted)",
                        }}>
                          {t("settings.skinCustomBadge")}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => { void deleteCustom(stem); }}
                      title={t("common.delete")}
                      style={{
                        display: "inline-flex",
                        "align-items": "center",
                        "justify-content": "center",
                        width: "24px",
                        height: "24px",
                        border: "none",
                        background: "transparent",
                        color: "var(--mz-text-muted)",
                        cursor: "pointer",
                        "border-radius": "var(--mz-radius-sm)",
                        "flex-shrink": "0",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "rgba(224,108,117,0.15)";
                        e.currentTarget.style.color = "var(--mz-error)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.color = "var(--mz-text-muted)";
                      }}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                        stroke="currentColor" stroke-width="2" stroke-linecap="round"
                        stroke-linejoin="round">
                        <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      <Show when={error()}>
        {(msg) => (
          <div style={{
            padding: "10px 12px",
            background: "color-mix(in srgb, var(--mz-error) 10%, transparent)",
            color: "var(--mz-error)",
            "font-size": "var(--mz-font-size-xs)",
            "border-radius": "var(--mz-radius-sm)",
          }}>
            {msg()}
          </div>
        )}
      </Show>

      <Show when={notice()}>
        {(msg) => (
          <div style={{
            padding: "10px 12px",
            background: "var(--mz-accent-subtle)",
            color: "var(--mz-accent)",
            "font-size": "var(--mz-font-size-xs)",
            "border-radius": "var(--mz-radius-sm)",
          }}>
            {msg()}
          </div>
        )}
      </Show>
    </div>
  );
};

const SkinCard: Component<{
  skin: BuiltInSkin;
  active: boolean;
  onSelect: () => void;
}> = (props) => {
  return (
    <button
      onClick={props.onSelect}
      style={{
        ...skinCardStyleBase,
        ...(props.active ? skinCardStyleActive : {}),
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        if (!props.active) {
          e.currentTarget.style.borderColor = "var(--mz-border-strong)";
        }
      }}
      onMouseLeave={(e) => {
        if (!props.active) {
          e.currentTarget.style.borderColor = "var(--mz-border)";
        }
      }}
    >
      <span style={{
        display: "inline-flex",
        width: "32px",
        height: "28px",
        "border-radius": "var(--mz-radius-sm)",
        border: "1px solid var(--mz-border)",
        overflow: "hidden",
        "flex-shrink": "0",
      }}>
        <span style={{
          display: "block",
          flex: "1",
          background: props.skin.swatch[0],
        }} />
        <span style={{
          display: "block",
          flex: "1",
          background: props.skin.swatch[1],
        }} />
      </span>
      <div style={{ "min-width": "0", flex: "1", "text-align": "left" }}>
        <div style={{
          "font-size": "var(--mz-font-size-sm)",
          color: props.active ? "var(--mz-accent)" : "var(--mz-text-primary)",
          "font-weight": props.active ? "600" : "500",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "white-space": "nowrap",
        }}>
          {props.skin.label}
        </div>
        <div style={{
          "font-size": "var(--mz-font-size-xs)",
          color: "var(--mz-text-muted)",
          "text-transform": "capitalize",
        }}>
          {props.skin.mode}
        </div>
      </div>
    </button>
  );
};

// A minimal CSS starter template written into new custom themes so the
// user has a working skeleton to edit — sets the five most-visible
// tokens and a comment block explaining which variables are available.
const SKIN_STARTER_CSS = `/* MindZJ custom skin.
   Uncomment / edit the variables below. Any CSS variables not set here
   fall back to the built-in dark palette. See
   src/styles/variables.css in the MindZJ repo for the full list. */

:root {
  --mz-bg-primary: #1b1f2a;
  --mz-bg-secondary: #151823;
  --mz-text-primary: #e5e9f0;
  --mz-accent: #7aa2f7;
  --mz-accent-hover: #a3bcf8;
}
`;

const skinCardStyleBase = {
  display: "flex",
  "align-items": "center",
  gap: "10px",
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--mz-border)",
  "border-radius": "var(--mz-radius-md)",
  background: "var(--mz-bg-primary)",
  cursor: "pointer",
  transition: "border-color 150ms, background 150ms",
} as const;

const skinCardStyleActive = {
  border: "2px solid var(--mz-accent)",
  background: "var(--mz-accent-subtle)",
  padding: "9px 11px", // compensate for the thicker border
} as const;

function skinBtnPrimary(disabled: boolean) {
  return {
    padding: "6px 12px",
    border: "1px solid var(--mz-accent)",
    background: disabled ? "var(--mz-bg-hover)" : "var(--mz-accent)",
    color: disabled ? "var(--mz-text-muted)" : "var(--mz-text-on-accent)",
    "border-radius": "var(--mz-radius-sm)",
    cursor: disabled ? "default" : "pointer",
    "font-size": "var(--mz-font-size-sm)",
    "font-family": "var(--mz-font-sans)",
    opacity: disabled ? "0.6" : "1",
  } as const;
}

function skinBtnSecondary(disabled: boolean) {
  return {
    padding: "6px 12px",
    border: "1px solid var(--mz-border)",
    background: "transparent",
    color: disabled ? "var(--mz-text-muted)" : "var(--mz-text-primary)",
    "border-radius": "var(--mz-radius-sm)",
    cursor: disabled ? "default" : "pointer",
    "font-size": "var(--mz-font-size-sm)",
    "font-family": "var(--mz-font-sans)",
    opacity: disabled ? "0.6" : "1",
  } as const;
}

import { invoke } from "@tauri-apps/api/core";
import { editorStore, type ViewMode } from "./editor";
import { aiModelSettingsKey, settingsStore, type AiProviderConfig, type AiProviderType, type AiSkill, type AppSettings } from "./settings";
import { vaultStore, type VaultEntry, type FileContent } from "./vault";
import { listPluginCommands, runPluginCommand, updatePluginViewsForFile } from "./plugins";
import {
  addMindzjNode,
  deleteMindzjNode,
  findMindzjNode,
  flattenMindzjNodes,
  mindzjDocumentFromMarkdown,
  parseMindzjDocument,
  serializeMindzjDocument,
  summarizeMindzjDocument,
  updateMindzjNodeText,
  type MindzjDocument,
  type MindzjNodeMatch,
  type MindzjTextPathInput,
} from "../utils/mindzjMindmap";

type ChatRole = "system" | "user" | "assistant" | "tool";

interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

type ToolResult = {
  ok: boolean;
  message?: string;
  data?: unknown;
};

type AiProviderFamily = "openai-compatible" | "anthropic" | "gemini";
type AiModelOption = { value: string; label: string };
type AiTextToSpeechResult = { path: string; fileName: string };

interface RunInstructionOptions {
  restrictToActiveFile?: boolean;
  onProgress?: (event: AiInstructionProgressEvent) => void;
}

interface AiConnectionTestResult {
  model?: string | null;
  content?: string | null;
  models?: string[];
}

interface AiInstructionProgressEvent {
  phase: "request" | "tool-call" | "tool-result" | "message" | "done" | "error";
  message: string;
}

interface ToolExecutionContext {
  restrictToActiveFile: boolean;
  activePath: string | null;
  hasExplicitPath: boolean;
}

export const BUILT_IN_ONLINE_PROVIDER_TYPES = ["OpenAI", "Claude", "Grok", "Gemini", "DeepSeek"] as const;
export const GROK_STT_MODEL = "grok-stt";
export const GROK_TTS_VOICES: AiModelOption[] = [
  { value: "eve", label: "Eve" },
  { value: "ara", label: "Ara" },
  { value: "rex", label: "Rex" },
  { value: "sal", label: "Sal" },
  { value: "leo", label: "Leo" },
];
export const GROK_TTS_LANGUAGE_OPTIONS: AiModelOption[] = [
  { value: "auto", label: "Auto" },
  { value: "zh", label: "Chinese" },
  { value: "en", label: "English" },
  { value: "ja", label: "Japanese" },
  { value: "ko", label: "Korean" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "es-ES", label: "Spanish" },
];

const PROVIDER_DEFAULTS: Record<AiProviderType, AiProviderConfig> = {
  Ollama: {
    provider_type: "Ollama",
    endpoint: "http://localhost:11434/v1",
    api_key: null,
    has_api_key: false,
    model: "llama3.2",
  },
  LMStudio: {
    provider_type: "LMStudio",
    endpoint: "http://localhost:1234/v1",
    api_key: null,
    has_api_key: false,
    model: "local-model",
  },
  ApiKeyLLM: {
    provider_type: "ApiKeyLLM",
    endpoint: null,
    api_key: null,
    has_api_key: false,
    model: "",
  },
  OpenAI: {
    provider_type: "OpenAI",
    display_name: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    api_key: null,
    has_api_key: false,
    model: "gpt-5.5",
  },
  Claude: {
    provider_type: "Claude",
    display_name: "Claude",
    endpoint: "https://api.anthropic.com/v1",
    api_key: null,
    has_api_key: false,
    model: "claude-sonnet-4-6",
  },
  Grok: {
    provider_type: "Grok",
    display_name: "Grok",
    endpoint: "https://api.x.ai/v1",
    api_key: null,
    has_api_key: false,
    model: "grok-4.20",
  },
  Gemini: {
    provider_type: "Gemini",
    display_name: "Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    api_key: null,
    has_api_key: false,
    model: "gemini-3-flash-preview",
  },
  DeepSeek: {
    provider_type: "DeepSeek",
    display_name: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    api_key: null,
    has_api_key: false,
    model: "deepseek-v4-pro",
  },
  Custom: {
    provider_type: "Custom",
    display_name: "Custom",
    endpoint: null,
    api_key: null,
    has_api_key: false,
    model: "",
  },
};

const BUILT_IN_MODEL_OPTIONS: Partial<Record<AiProviderType, AiModelOption[]>> = {
  OpenAI: [
    { value: "gpt-5.5", label: "GPT-5.5" },
    { value: "gpt-5.4", label: "GPT-5.4" },
    { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
    { value: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
  ],
  Claude: [
    { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  Grok: [
    { value: "grok-4.20", label: "Grok 4.20" },
    { value: "grok-4.20-reasoning", label: "Grok 4.20 Reasoning" },
    { value: "grok-4", label: "Grok 4" },
  ],
  Gemini: [
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
    { value: "gemini-3-pro-preview", label: "Gemini 3 Pro Preview" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite" },
    { value: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  ],
  DeepSeek: [
    { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
    { value: "deepseek-chat", label: "DeepSeek Chat" },
    { value: "deepseek-reasoner", label: "DeepSeek Reasoner" },
  ],
};

function cloneConfig(config: AiProviderConfig): AiProviderConfig {
  return { ...config };
}

function normalizeProviderType(provider: AiProviderType): AiProviderType {
  return provider in PROVIDER_DEFAULTS ? provider : "ApiKeyLLM";
}

export function isBuiltInOnlineProviderType(provider: AiProviderType): boolean {
  return (BUILT_IN_ONLINE_PROVIDER_TYPES as readonly string[]).includes(provider);
}

export function builtInModelOptions(provider: AiProviderType): AiModelOption[] {
  return BUILT_IN_MODEL_OPTIONS[normalizeProviderType(provider)] ?? [];
}

function isLocalProviderType(provider: AiProviderType): boolean {
  return provider === "Ollama" || provider === "LMStudio";
}

function providerDisplayName(config: AiProviderConfig): string {
  const providerType = normalizeProviderType(config.provider_type);
  if (providerType === "LMStudio") return "LM Studio";
  if (providerType === "Ollama") return "Ollama";
  if (providerType === "OpenAI") return "OpenAI";
  if (providerType === "Claude") return "Claude";
  if (providerType === "Grok") return "Grok";
  if (providerType === "Gemini") return "Gemini";
  if (providerType === "DeepSeek") return "DeepSeek";
  return (config.display_name || "Online LLM").trim();
}

function modelDisplayName(config: AiProviderConfig): string {
  const model = config.model.trim();
  if (!model) return "";
  return builtInModelOptions(config.provider_type).find((option) => option.value === model)?.label ?? model;
}

export function aiProviderModelLabel(config: AiProviderConfig | null | undefined): string {
  if (!config) return "Ollama";
  const provider = providerDisplayName(config);
  if (isLocalProviderType(config.provider_type)) return provider;
  const model = modelDisplayName(config);
  if (!model || model === provider) return provider;
  return `${provider} · ${model}`;
}

export function defaultAiProviderConfig(provider: AiProviderType): AiProviderConfig {
  return cloneConfig(PROVIDER_DEFAULTS[normalizeProviderType(provider)]);
}

function configuredProvider(): AiProviderConfig | null {
  return settingsStore.settings().ai_provider ?? defaultAiProviderConfig("Ollama");
}

function configuredGrokProvider(): AiProviderConfig {
  const settings = settingsStore.settings();
  if (settings.ai_provider?.provider_type === "Grok") return settings.ai_provider;
  return settings.ai_custom_providers?.find((config) => config.provider_type === "Grok" && !config.id)
    ?? defaultAiProviderConfig("Grok");
}

function providerBaseUrl(config: AiProviderConfig): string {
  const providerType = normalizeProviderType(config.provider_type);
  const fallback = !isLocalProviderType(providerType)
    ? defaultApiKeyEndpoint(config)
    : PROVIDER_DEFAULTS[providerType]?.endpoint ?? "";
  const base = (config.endpoint || fallback || "").replace(/\/+$/, "");
  if (inferProviderFamily(config) === "gemini") {
    return base
      .replace(/\/models\/[^/]+(?::(?:generateContent|streamGenerateContent))?$/i, "")
      .replace(/\/models$/i, "");
  }
  return base;
}

function modelHint(config: AiProviderConfig): string {
  return `${config.display_name ?? ""} ${config.model ?? ""}`.toLowerCase();
}

function inferProviderFamily(config: AiProviderConfig): AiProviderFamily {
  const providerType = normalizeProviderType(config.provider_type);
  if (providerType === "Claude") return "anthropic";
  if (providerType === "Gemini") return "gemini";
  const endpoint = (config.endpoint ?? "").toLowerCase();
  const hint = modelHint(config);
  if (endpoint.includes("anthropic.com")) return "anthropic";
  if (endpoint.includes("generativelanguage.googleapis.com")) return "gemini";
  if (endpoint) return "openai-compatible";
  if (hint.includes("claude")) return "anthropic";
  if (hint.includes("gemini")) return "gemini";
  return "openai-compatible";
}

function defaultApiKeyEndpoint(config: AiProviderConfig): string {
  const providerType = normalizeProviderType(config.provider_type);
  const providerDefault = !isLocalProviderType(providerType)
    ? PROVIDER_DEFAULTS[providerType]?.endpoint
    : null;
  if (providerDefault) return providerDefault;
  const family = inferProviderFamily(config);
  if (family === "anthropic") return "https://api.anthropic.com/v1";
  if (family === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  if (modelHint(config).includes("grok") || modelHint(config).includes("xai")) {
    return "https://api.x.ai/v1";
  }
  if (modelHint(config).includes("deepseek")) return "https://api.deepseek.com";
  return "https://api.openai.com/v1";
}

function providerNeedsRealKey(provider: AiProviderType): boolean {
  return !isLocalProviderType(normalizeProviderType(provider));
}

function configMatchesProvider(config: AiProviderConfig, provider: string): boolean {
  const trimmed = provider.trim();
  if (config.id) return config.id === trimmed;
  return normalizeProviderType(config.provider_type) === trimmed;
}

function providerStorageId(config: AiProviderConfig): string {
  return config.id || normalizeProviderType(config.provider_type);
}

function stripCopiedModelPath(value: string): string {
  let model = value.trim().replace(/^["']|["']$/g, "");
  if (!model) return "";
  try {
    if (/^https?:\/\//i.test(model)) {
      const url = new URL(model);
      model = url.pathname;
    }
  } catch {
    // Keep the original value; the provider will report a precise error.
  }
  model = model
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/:(?:generateContent|streamGenerateContent)$/i, "");
  const modelsMatch = model.match(/(?:^|\/)models\/([^/:]+)$/i);
  if (modelsMatch?.[1]) return modelsMatch[1];
  return model;
}

function openAiCompatibleModelId(config: AiProviderConfig): string {
  let model = stripCopiedModelPath(config.model).replace(/^models\//i, "");
  const base = providerBaseUrl(config).toLowerCase();
  const preserveProviderPrefix = base.includes("openrouter.ai");
  if (!preserveProviderPrefix && model.includes("/")) {
    model = model.split("/").filter(Boolean).pop() ?? model;
  }
  return model;
}

function flattenEntries(entries: VaultEntry[], result: Array<{ path: string; name: string; is_dir: boolean }> = []) {
  for (const entry of entries) {
    result.push({
      path: entry.relative_path,
      name: entry.name,
      is_dir: entry.is_dir,
    });
    if (entry.children) flattenEntries(entry.children, result);
  }
  return result;
}

function cleanPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").trim();
}

function isMindmapPath(path: string | null | undefined): boolean {
  return !!path && /\.mindzj$/i.test(path.trim());
}

function isMarkdownPath(path: string | null | undefined): boolean {
  return !!path && /\.md$/i.test(path.trim());
}

function ensureMindmapPath(path: string): string {
  const clean = cleanPath(path);
  if (!clean) return "";
  return /\.mindzj$/i.test(clean) ? clean : `${clean.replace(/\.[^/.]+$/, "")}.mindzj`;
}

function defaultMindmapPathForSource(sourcePath: string): string {
  return ensureMindmapPath(sourcePath.replace(/\.[^/.]+$/, ""));
}

function sanitizeMindmapFileName(value: string): string {
  const cleaned = value
    .replace(/[#*_`~[\]()]/g, "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 48)
    .trim();
  return cleaned || "MindZJMap";
}

function firstOutlineTitle(outline: string, fallback?: string): string {
  for (const rawLine of outline.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    return sanitizeMindmapFileName(line.replace(/^#{1,6}\s+/, "").replace(/^(?:[-*+]|\d+[.)])\s+/, ""));
  }
  return sanitizeMindmapFileName(fallback || "MindZJMap");
}

function uniqueMindmapPath(baseName: string): string {
  const existing = new Set(
    flattenEntries(vaultStore.fileTree())
      .filter((entry) => !entry.is_dir)
      .map((entry) => entry.path.toLowerCase()),
  );
  const base = sanitizeMindmapFileName(baseName);
  let candidate = `${base}.mindzj`;
  let suffix = 1;
  while (existing.has(candidate.toLowerCase())) {
    candidate = `${base} ${suffix}.mindzj`;
    suffix += 1;
  }
  return candidate;
}

function parseJsonObject(value: string): any | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function mindmapPathRequiredResult(toolName: string): ToolResult {
  return {
    ok: false,
    message: `${toolName} requires a .mindzj path or an active .mindzj file.`,
  };
}

function resolveMindmapPath(
  toolName: string,
  rawPath: string | null | undefined,
  context?: ToolExecutionContext,
): { ok: true; path: string } | { ok: false; result: ToolResult } {
  const requested = ensureMindmapPath(String(rawPath ?? ""));
  const activePath = context?.activePath ?? vaultStore.activeFile()?.path ?? null;
  const fallback = isMindmapPath(activePath) ? activePath! : "";
  const path = requested || fallback;
  if (!path) return { ok: false, result: mindmapPathRequiredResult(toolName) };
  if (!isMindmapPath(path)) {
    return { ok: false, result: { ok: false, message: `${path} is not a .mindzj file.` } };
  }
  if (context?.restrictToActiveFile && !context.hasExplicitPath && requested && requested !== activePath) {
    return {
      ok: false,
      result: {
        ok: false,
        message: `No explicit file path was provided. Refusing to modify ${requested}; only ${activePath ?? "(none)"} may be changed.`,
      },
    };
  }
  return { ok: true, path };
}

function textPathArg(value: unknown): MindzjTextPathInput {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === "string") return value;
  return null;
}

function nodeReferenceFromArgs(args: any): { nodeId?: string | null; textPath?: MindzjTextPathInput; text?: string | null } {
  return {
    nodeId: typeof args.node_id === "string" ? args.node_id : null,
    textPath: textPathArg(args.text_path),
    text: typeof args.current_text === "string" ? args.current_text : null,
  };
}

function nodeTargetMissingResult(toolName: string): ToolResult {
  return {
    ok: false,
    message: `${toolName} requires node_id, text_path, or unique current_text.`,
  };
}

function nodeNotFoundResult(toolName: string): ToolResult {
  return {
    ok: false,
    message: `${toolName} could not find a unique matching node. Use read_mindmap first and retry with node_id.`,
  };
}

function countMindmapNodes(document: MindzjDocument): number {
  return flattenMindzjNodes(document).length;
}

async function readMindmapFile(path: string): Promise<MindzjDocument> {
  const file = await invoke<FileContent>("read_file", { relativePath: path });
  return parseMindzjDocument(file.content);
}

async function saveMindmapFile(path: string, document: MindzjDocument, openAfterSave = false): Promise<FileContent> {
  const content = serializeMindzjDocument(document);
  let file: FileContent;
  try {
    file = await vaultStore.createFile(path, content);
  } catch (error: any) {
    if (!isFileAlreadyExistsError(error)) throw error;
    file = await vaultStore.saveFile(path, content);
  }
  await updatePluginViewsForFile(file.path, content, true);
  if (openAfterSave) await vaultStore.openFile(file.path);
  return file;
}

function readMindmapResult(path: string, document: MindzjDocument, query?: string): ToolResult {
  const trimmedQuery = query?.trim().toLowerCase() ?? "";
  const allNodes = flattenMindzjNodes(document);
  const matches = trimmedQuery
    ? allNodes
        .filter((match) => match.node.text.toLowerCase().includes(trimmedQuery))
        .slice(0, 80)
        .map((match) => ({
          id: match.node.id,
          text: match.node.text,
          path: match.path,
          side: match.node.side ?? null,
        }))
    : [];
  return {
    ok: true,
    data: {
      path,
      node_count: allNodes.length,
      root_count: document.rootNodes.length,
      outline: summarizeMindzjDocument(document),
      ...(trimmedQuery ? { matches } : {}),
    },
  };
}

function mindmapChangeMessage(action: string, path: string, match: MindzjNodeMatch): string {
  return `${action} ${match.path.join(" > ")} in ${path}`;
}

const NOTE_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Vault-relative path, for example notes/today.md" },
  },
  required: ["path"],
  additionalProperties: false,
};

const OPTIONAL_MINDMAP_PATH_PROPERTY = {
  type: "string",
  description: "Vault-relative .mindzj path. Optional when the active file is the target mind map.",
};

const MINDMAP_TEXT_PATH_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "Node text path from root to target, for example [\"Project\", \"Tasks\", \"Done\"]. Prefer node_id after read_mindmap when possible.",
};

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List notes and folders in the current vault.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_app_commands",
      description: "List built-in automation tool names and registered plugin command ids.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_active_note",
      description: "Get the currently active note path and view mode.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description: "Read the full contents of a vault note.",
      parameters: NOTE_TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "list_mindmaps",
      description: "List .mindzj mind map files in the current vault.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_mindmap",
      description: "Read a .mindzj mind map as a structured node outline. Use this before editing nodes to get node ids or text paths.",
      parameters: {
        type: "object",
        properties: {
          path: OPTIONAL_MINDMAP_PATH_PROPERTY,
          query: { type: "string", description: "Optional text query to return matching nodes." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_mindmap_from_markdown",
      description: "Convert a Markdown file into a .mindzj mind map. Defaults to the active Markdown file and writes beside it using the .mindzj extension.",
      parameters: {
        type: "object",
        properties: {
          source_path: { type: "string", description: "Vault-relative Markdown source path. Optional when the active file is Markdown." },
          target_path: { type: "string", description: "Vault-relative .mindzj target path. Optional; defaults to source basename with .mindzj extension." },
          root_title: { type: "string", description: "Fallback root title when the Markdown content has no H1 heading." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_mindmap",
      description: "Create or replace a .mindzj mind map from an indented Markdown outline such as '# Root\\n## Branch\\n- Leaf'.",
      parameters: {
        type: "object",
        properties: {
          path: OPTIONAL_MINDMAP_PATH_PROPERTY,
          outline_markdown: { type: "string", description: "Markdown outline to convert to rootNodes." },
          root_title: { type: "string", description: "Fallback root title when outline_markdown has no H1 heading." },
        },
        required: ["outline_markdown"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_mindmap_node",
      description: "Add a node to a .mindzj mind map. If parent is omitted, add under the only root node, or create a new root when the map has multiple roots.",
      parameters: {
        type: "object",
        properties: {
          path: OPTIONAL_MINDMAP_PATH_PROPERTY,
          parent_id: { type: "string", description: "Parent node id from read_mindmap." },
          parent_text_path: MINDMAP_TEXT_PATH_PROPERTY,
          parent_text: { type: "string", description: "Parent node text, only when it is unique." },
          text: { type: "string", description: "New node text." },
          index: { type: "number", description: "Optional child insertion index." },
          side: { type: "string", enum: ["left", "right"], description: "Optional side for root children." },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_mindmap_node",
      description: "Change the text of one node in a .mindzj mind map.",
      parameters: {
        type: "object",
        properties: {
          path: OPTIONAL_MINDMAP_PATH_PROPERTY,
          node_id: { type: "string", description: "Target node id from read_mindmap." },
          text_path: MINDMAP_TEXT_PATH_PROPERTY,
          current_text: { type: "string", description: "Current target text, only when it is unique." },
          text: { type: "string", description: "Replacement node text." },
        },
        required: ["text"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_mindmap_node",
      description: "Delete one node and its children from a .mindzj mind map.",
      parameters: {
        type: "object",
        properties: {
          path: OPTIONAL_MINDMAP_PATH_PROPERTY,
          node_id: { type: "string", description: "Target node id from read_mindmap." },
          text_path: MINDMAP_TEXT_PATH_PROPERTY,
          current_text: { type: "string", description: "Current target text, only when it is unique." },
          allow_delete_root: { type: "boolean", description: "Set true only when the user explicitly asked to delete a root node." },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new note with content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_note",
      description: "Replace the full content of an existing note.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "append_note",
      description: "Append text to the end of a note.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Delete a note from the vault.",
      parameters: NOTE_TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "delete_folder",
      description: "Delete a folder from the vault.",
      parameters: NOTE_TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "rename_note",
      description: "Rename or move a note.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_notes",
      description: "Search text across the vault.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_backlinks",
      description: "Get notes that link to a vault note.",
      parameters: NOTE_TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "get_forward_links",
      description: "Get notes that a vault note links to.",
      parameters: NOTE_TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "get_graph_data",
      description: "Get current vault graph data.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_note",
      description: "Open a note in the editor.",
      parameters: NOTE_TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "create_folder",
      description: "Create a folder in the vault.",
      parameters: NOTE_TOOL_PARAMETERS,
    },
  },
  {
    type: "function",
    function: {
      name: "refresh_file_tree",
      description: "Refresh the vault file tree from disk.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_view_mode",
      description: "Set the active note view mode.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["source", "live-preview", "reading"] },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_default_view_mode",
      description: "Set the default note view mode in settings.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["Source", "LivePreview", "Reading"] },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_settings",
      description: "Read current app settings. API keys are not included.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_setting",
      description: "Update one app setting by key. Use get_settings first to inspect available keys.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: {},
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_plugin_command",
      description: "Run a registered plugin command by command id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  },
];

function instructionMentionsExplicitPath(instruction: string): boolean {
  const text = instruction.trim();
  if (!text) return false;
  return /\.(?:md|mindzj)\b/i.test(text)
    || /\[\[[^\]]+\]\]/.test(text)
    || /(?:^|[\s"'`])[\w\u4e00-\u9fff ._-]+\/[\w\u4e00-\u9fff ./_-]+(?:$|[\s"'`])/u.test(text);
}

function buildToolContext(instruction: string, options?: RunInstructionOptions): ToolExecutionContext {
  return {
    restrictToActiveFile: !!options?.restrictToActiveFile,
    activePath: vaultStore.activeFile()?.path ?? null,
    hasExplicitPath: instructionMentionsExplicitPath(instruction),
  };
}

function looksLikeActiveNoteContentRequest(instruction: string): boolean {
  const text = instruction.trim().toLowerCase();
  if (!text) return false;

  const explicitWrite = /(写入|录入|记入|记录|保存|加入|添加|追加|插入|放到|放入|粘贴|输出到|写进|写到|append|insert|add|write|save|paste)/iu;
  const generatedContent = /(翻译|译成|总结|摘要|概括|改写|润色|扩写|缩写|整理|生成|起草|撰写|写一|写个|写成|列出|提取|转换为|转成|translate|summari[sz]e|rewrite|polish|draft|compose|generate|extract|convert)/iu;
  const plainQuestion = /^(什么|为什么|怎么|如何|请问|能否|可以|是否|哪|who|what|why|how|can|could|should|is|are)\b/iu;

  if (explicitWrite.test(text)) return true;
  if (generatedContent.test(text) && !plainQuestion.test(text)) return true;
  return false;
}

function isFileAlreadyExistsError(error: any): boolean {
  const text = [
    error?.code,
    error?.message,
    String(error ?? ""),
  ].filter(Boolean).join(" ");
  return /FILE_ALREADY_EXISTS|File already exists/i.test(text);
}

function looksLikeToolFailureSummary(content: string): boolean {
  const firstChunk = content.trim().slice(0, 1200).toLowerCase();
  if (!firstChunk) return false;
  const hasFailureLanguage = /(access denied|permission denied|file not found|failed|error|issue|cannot|can't|refusing|not something i can|权限|拒绝|失败|错误|无法|不能)/i.test(firstChunk);
  const hasReportShape = /(summary|what i attempted|recommended solution|option a|option b|issue|problem|attempted)/i.test(firstChunk);
  return hasFailureLanguage && hasReportShape;
}

function pathRequiredResult(toolName: string): ToolResult {
  return {
    ok: false,
    message: `${toolName} requires a vault-relative path.`,
  };
}

function emitProgress(options: RunInstructionOptions | undefined, phase: AiInstructionProgressEvent["phase"], message: string) {
  try {
    options?.onProgress?.({ phase, message });
  } catch {
    // Progress rendering must never break the actual AI action.
  }
}

function summarizeToolCall(name: string, args: any): string {
  const path = cleanPath(String(args?.path ?? args?.from ?? args?.to ?? ""));
  if (path) return `${name}(${path})`;
  return name;
}

function enforceCurrentFileContentScope(
  toolName: string,
  rawPath: string,
  context?: ToolExecutionContext,
): { ok: true; path: string } | { ok: false; result: ToolResult } {
  const path = cleanPath(rawPath);
  if (!context?.restrictToActiveFile) {
    return path ? { ok: true, path } : { ok: false, result: pathRequiredResult(toolName) };
  }
  if (context.hasExplicitPath) {
    return path ? { ok: true, path } : { ok: false, result: pathRequiredResult(toolName) };
  }

  if (toolName !== "create_note" && toolName !== "update_note" && toolName !== "append_note") {
    return {
      ok: false,
      result: {
        ok: false,
        message: "No explicit file path was provided. This AI panel may only change the current note content.",
      },
    };
  }

  if (!context.activePath) {
    return {
      ok: false,
      result: {
        ok: false,
        message: "No active note is available to modify.",
      },
    };
  }

  if (!path) return { ok: true, path: context.activePath };
  if (path !== context.activePath) {
    return {
      ok: false,
      result: {
        ok: false,
        message: `No explicit file path was provided. Refusing to modify ${path}; only ${context.activePath} may be changed.`,
      },
    };
  }
  return { ok: true, path };
}

async function executeTool(name: string, args: any, context?: ToolExecutionContext): Promise<ToolResult> {
  try {
    switch (name) {
      case "list_notes": {
        return { ok: true, data: flattenEntries(vaultStore.fileTree()).slice(0, 500) };
      }
      case "list_app_commands": {
        return {
          ok: true,
          data: {
            tools: TOOLS.map((tool) => tool.function.name),
            plugin_commands: listPluginCommands().map((command) => ({
              id: command.id,
              name: command.name,
            })),
          },
        };
      }
      case "get_active_note": {
        const active = vaultStore.activeFile();
        return {
          ok: true,
          data: {
            path: active?.path ?? null,
            view_mode: editorStore.getViewModeForFile(active?.path ?? null),
          },
        };
      }
      case "read_note": {
        const path = cleanPath(String(args.path ?? ""));
        if (!path) return pathRequiredResult(name);
        const file = await invoke<FileContent>("read_file", { relativePath: path });
        return { ok: true, data: { path: file.path, content: file.content } };
      }
      case "list_mindmaps": {
        return {
          ok: true,
          data: flattenEntries(vaultStore.fileTree())
            .filter((entry) => !entry.is_dir && isMindmapPath(entry.path))
            .slice(0, 500),
        };
      }
      case "read_mindmap": {
        const resolved = resolveMindmapPath(name, String(args.path ?? ""), context);
        if (!resolved.ok) return resolved.result;
        const document = await readMindmapFile(resolved.path);
        return readMindmapResult(resolved.path, document, typeof args.query === "string" ? args.query : undefined);
      }
      case "create_mindmap_from_markdown": {
        const activePath = context?.activePath ?? vaultStore.activeFile()?.path ?? null;
        const sourcePath = cleanPath(String(args.source_path ?? "")) || (isMarkdownPath(activePath) ? activePath! : "");
        if (!sourcePath) {
          return { ok: false, message: "create_mindmap_from_markdown requires source_path or an active Markdown file." };
        }
        if (context?.restrictToActiveFile && !context.hasExplicitPath && sourcePath !== activePath) {
          return {
            ok: false,
            message: `No explicit file path was provided. Refusing to read ${sourcePath}; only ${activePath ?? "(none)"} may be used.`,
          };
        }
        const targetPath = ensureMindmapPath(String(args.target_path ?? "")) || defaultMindmapPathForSource(sourcePath);
        const source = await invoke<FileContent>("read_file", { relativePath: sourcePath });
        const document = mindzjDocumentFromMarkdown(source.content, {
          rootTitle: typeof args.root_title === "string" ? args.root_title : sourcePath.split("/").pop()?.replace(/\.[^.]+$/, ""),
        });
        const file = await saveMindmapFile(targetPath, document, true);
        return {
          ok: true,
          message: `Created ${file.path} from ${sourcePath}`,
          data: { path: file.path, source_path: sourcePath, node_count: countMindmapNodes(document) },
        };
      }
      case "create_mindmap": {
        const outline = String(args.outline_markdown ?? "").trim();
        if (!outline) return { ok: false, message: "create_mindmap requires outline_markdown." };
        const requestedPath = ensureMindmapPath(String(args.path ?? ""));
        const activePath = context?.activePath ?? vaultStore.activeFile()?.path ?? null;
        const targetPath = requestedPath || uniqueMindmapPath(firstOutlineTitle(outline, typeof args.root_title === "string" ? args.root_title : undefined));
        if (context?.restrictToActiveFile && !context.hasExplicitPath && requestedPath && requestedPath !== activePath) {
          return {
            ok: false,
            message: `No explicit file path was provided. Refusing to replace ${requestedPath}; omit path to create a new mind map automatically.`,
          };
        }
        const document = mindzjDocumentFromMarkdown(outline, {
          rootTitle: typeof args.root_title === "string" ? args.root_title : undefined,
        });
        const file = await saveMindmapFile(targetPath, document, true);
        return {
          ok: true,
          message: `Created ${file.path}`,
          data: { path: file.path, node_count: countMindmapNodes(document) },
        };
      }
      case "add_mindmap_node": {
        const resolved = resolveMindmapPath(name, String(args.path ?? ""), context);
        if (!resolved.ok) return resolved.result;
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, message: "add_mindmap_node requires text." };
        const document = await readMindmapFile(resolved.path);
        const match = addMindzjNode(document, {
          text,
          parentId: typeof args.parent_id === "string" ? args.parent_id : null,
          parentTextPath: textPathArg(args.parent_text_path),
          parentText: typeof args.parent_text === "string" ? args.parent_text : null,
          index: typeof args.index === "number" ? args.index : null,
          side: typeof args.side === "string" ? args.side : null,
        });
        await saveMindmapFile(resolved.path, document);
        return { ok: true, message: mindmapChangeMessage("Added", resolved.path, match), data: { id: match.node.id, path: match.path } };
      }
      case "update_mindmap_node": {
        const resolved = resolveMindmapPath(name, String(args.path ?? ""), context);
        if (!resolved.ok) return resolved.result;
        const text = String(args.text ?? "").trim();
        if (!text) return { ok: false, message: "update_mindmap_node requires text." };
        const reference = nodeReferenceFromArgs(args);
        if (!reference.nodeId && !reference.textPath && !reference.text) return nodeTargetMissingResult(name);
        const document = await readMindmapFile(resolved.path);
        const match = findMindzjNode(document, reference);
        if (!match) return nodeNotFoundResult(name);
        const updated = updateMindzjNodeText(match, text);
        await saveMindmapFile(resolved.path, document);
        return { ok: true, message: mindmapChangeMessage("Updated", resolved.path, updated), data: { id: updated.node.id, path: updated.path } };
      }
      case "delete_mindmap_node": {
        const resolved = resolveMindmapPath(name, String(args.path ?? ""), context);
        if (!resolved.ok) return resolved.result;
        const reference = nodeReferenceFromArgs(args);
        if (!reference.nodeId && !reference.textPath && !reference.text) return nodeTargetMissingResult(name);
        const document = await readMindmapFile(resolved.path);
        const match = findMindzjNode(document, reference);
        if (!match) return nodeNotFoundResult(name);
        const deleted = deleteMindzjNode(document, match, !!args.allow_delete_root);
        await saveMindmapFile(resolved.path, document);
        return { ok: true, message: mindmapChangeMessage("Deleted", resolved.path, deleted), data: { id: deleted.node.id, path: deleted.path } };
      }
      case "create_note": {
        const scoped = enforceCurrentFileContentScope(name, String(args.path ?? ""), context);
        if (!scoped.ok) return scoped.result;
        const path = scoped.path;
        const content = String(args.content ?? "");
        try {
          const file = await vaultStore.createFile(path, content);
          await vaultStore.openFile(file.path);
          return { ok: true, message: `Created ${file.path}`, data: file };
        } catch (error: any) {
          if (!isFileAlreadyExistsError(error)) throw error;
          const file = await vaultStore.saveFile(path, content);
          await vaultStore.openFile(file.path);
          return { ok: true, message: `Updated existing ${file.path}`, data: file };
        }
      }
      case "update_note": {
        const scoped = enforceCurrentFileContentScope(name, String(args.path ?? ""), context);
        if (!scoped.ok) return scoped.result;
        const path = scoped.path;
        const content = String(args.content ?? "");
        const file = await vaultStore.saveFile(path, content);
        return { ok: true, message: `Updated ${file.path}`, data: file };
      }
      case "append_note": {
        const scoped = enforceCurrentFileContentScope(name, String(args.path ?? ""), context);
        if (!scoped.ok) return scoped.result;
        const path = scoped.path;
        const content = String(args.content ?? "");
        const file = await invoke<FileContent>("read_file", { relativePath: path });
        const next = file.content.endsWith("\n") || content.startsWith("\n")
          ? `${file.content}${content}`
          : `${file.content}\n${content}`;
        const saved = await vaultStore.saveFile(path, next);
        return { ok: true, message: `Appended to ${saved.path}`, data: saved };
      }
      case "delete_note": {
        const scoped = enforceCurrentFileContentScope(name, String(args.path ?? ""), context);
        if (!scoped.ok) return scoped.result;
        const path = scoped.path;
        await vaultStore.deleteFile(path);
        return { ok: true, message: `Deleted ${path}` };
      }
      case "delete_folder": {
        const scoped = enforceCurrentFileContentScope(name, String(args.path ?? ""), context);
        if (!scoped.ok) return scoped.result;
        const path = scoped.path;
        await vaultStore.deleteDir(path);
        return { ok: true, message: `Deleted folder ${path}` };
      }
      case "rename_note": {
        if (context?.restrictToActiveFile && !context.hasExplicitPath) {
          return {
            ok: false,
            message: "No explicit file path was provided. This AI panel may only change the current note content.",
          };
        }
        const from = cleanPath(String(args.from ?? ""));
        const to = cleanPath(String(args.to ?? ""));
        const file = await invoke<FileContent>("rename_file", { from, to });
        vaultStore.renameFilePath(from, file.path);
        await vaultStore.refreshFileTree();
        return { ok: true, message: `Renamed ${from} to ${file.path}`, data: file };
      }
      case "search_notes": {
        const query = String(args.query ?? "");
        const results = await invoke("search_vault", {
          query,
          limit: 20,
          extensionFilter: null,
          pathFilter: null,
        });
        return { ok: true, data: results };
      }
      case "get_backlinks": {
        const path = cleanPath(String(args.path ?? ""));
        if (!path) return pathRequiredResult(name);
        const links = await invoke("get_backlinks", { relativePath: path });
        return { ok: true, data: links };
      }
      case "get_forward_links": {
        const path = cleanPath(String(args.path ?? ""));
        if (!path) return pathRequiredResult(name);
        const links = await invoke("get_forward_links", { relativePath: path });
        return { ok: true, data: links };
      }
      case "get_graph_data": {
        const graph = await invoke("get_graph_data");
        return { ok: true, data: graph };
      }
      case "open_note": {
        const path = cleanPath(String(args.path ?? ""));
        if (!path) return pathRequiredResult(name);
        const file = await vaultStore.openFile(path);
        return { ok: true, message: `Opened ${file.path}`, data: { path: file.path } };
      }
      case "create_folder": {
        const scoped = enforceCurrentFileContentScope(name, String(args.path ?? ""), context);
        if (!scoped.ok) return scoped.result;
        const path = scoped.path;
        await vaultStore.createDir(path);
        return { ok: true, message: `Created folder ${path}` };
      }
      case "refresh_file_tree": {
        await vaultStore.refreshFileTree();
        return { ok: true, message: "Refreshed file tree" };
      }
      case "set_view_mode": {
        const mode = String(args.mode ?? "live-preview") as ViewMode;
        editorStore.setViewMode(mode);
        return { ok: true, message: `View mode set to ${mode}` };
      }
      case "set_default_view_mode": {
        const mode = String(args.mode ?? "LivePreview");
        if (!["Source", "LivePreview", "Reading"].includes(mode)) {
          return { ok: false, message: `Invalid default view mode: ${mode}` };
        }
        await settingsStore.updateSetting("default_view_mode", mode);
        return { ok: true, message: `Default view mode set to ${mode}` };
      }
      case "get_settings": {
        return { ok: true, data: settingsStore.settings() };
      }
      case "update_setting": {
        const key = String(args.key ?? "") as keyof AppSettings;
        if (!(key in settingsStore.settings())) {
          return { ok: false, message: `Unknown setting: ${String(key)}` };
        }
        await settingsStore.updateSetting(key, args.value as AppSettings[typeof key]);
        return { ok: true, message: `Updated setting ${String(key)}` };
      }
      case "run_plugin_command": {
        const id = String(args.id ?? "");
        const exists = listPluginCommands().some((command) => command.id === id);
        if (!exists) return { ok: false, message: `Unknown plugin command: ${id}` };
        const ok = await runPluginCommand(id);
        return { ok, message: ok ? `Ran ${id}` : `Command failed: ${id}` };
      }
      default:
        return { ok: false, message: `Unknown tool: ${name}` };
    }
  } catch (error: any) {
    return { ok: false, message: error?.message || String(error) };
  }
}

async function appendNaturalResponseToActiveNote(
  instruction: string,
  content: string,
  context?: ToolExecutionContext,
): Promise<string | null> {
  const trimmed = content.trim();
  if (!trimmed || !context?.restrictToActiveFile || context.hasExplicitPath || !context.activePath) {
    return null;
  }
  if (!looksLikeActiveNoteContentRequest(instruction)) return null;
  if (looksLikeToolFailureSummary(trimmed)) return null;

  // Some local models ignore function calling for simple generation tasks.
  // Treat their final text as the content to record in the active Markdown note.
  const result = await executeTool("append_note", {
    path: context.activePath,
    content: trimmed,
  }, context);
  return result.message || (result.ok ? `Appended to ${context.activePath}` : null);
}

function configuredPromptAndSkills(config: AiProviderConfig): { prompt: string; skills: AiSkill[] } {
  const settings = settingsStore.settings();
  const key = aiModelSettingsKey(config);
  const prompt = (settings.ai_model_prompts?.[key] ?? "").trim();
  const selected = new Set(settings.ai_model_skill_ids?.[key] ?? []);
  const skills = (settings.ai_skills ?? [])
    .filter((skill) => selected.has(skill.id) && skill.content.trim());
  return { prompt, skills };
}

function buildSystemPrompt(context?: ToolExecutionContext, config?: AiProviderConfig) {
  const active = vaultStore.activeFile()?.path ?? "(none)";
  const commands = listPluginCommands().map((command) => command.id).slice(0, 80);
  const modelConfig = config ? configuredPromptAndSkills(config) : { prompt: "", skills: [] };
  const lines = [
    "You are MindZJ's local automation agent.",
    "Use tools to inspect and modify the user's current vault. Do not invent file contents or paths.",
    "The bottom AI command panel is for executing note actions, not casual chat.",
    ".mindzj files are MindZJ mind maps. Use read_mindmap, create_mindmap_from_markdown, create_mindmap, add_mindmap_node, update_mindmap_node, and delete_mindmap_node for them instead of hand-writing raw JSON.",
    "To turn Markdown into a mind map, call create_mindmap_from_markdown. If the user omits a target path, write beside the source with the .mindzj extension.",
    "For mind map node edits, call read_mindmap first when you need node ids, then edit by node_id or text_path.",
    "If the user asks you to translate, draft, summarize, rewrite, polish, generate, or record content, write the result into the target note with create_note, update_note, or append_note.",
    "If the user did not name a target note, write content changes to the active note.",
    "For destructive changes, only perform the exact action requested by the user.",
    "If a note already exists, update it with the requested content instead of writing a troubleshooting report.",
    "If a tool fails, report the exact failure in one short sentence. Do not produce long summaries or solution lists.",
    "When you finish, summarize what you changed in one concise sentence.",
    `Active note: ${active}`,
    `Available plugin command ids: ${commands.join(", ") || "(none)"}`,
    "If tool calling is unavailable, respond with JSON like {\"tool\":\"read_note\",\"arguments\":{\"path\":\"note.md\"}}, {\"tool\":\"read_mindmap\",\"arguments\":{\"path\":\"map.mindzj\"}}, or {\"actions\":[...]} only.",
  ];
  if (modelConfig.prompt) {
    lines.push("User-configured prompt for this model:", modelConfig.prompt);
  }
  for (const skill of modelConfig.skills) {
    lines.push(
      `Skill: ${skill.name}`,
      skill.description ? `Skill description: ${skill.description}` : "",
      skill.content.trim(),
    );
  }
  if (context?.restrictToActiveFile && !context.hasExplicitPath) {
    lines.push(
      `The user did not name a specific file path. Any content-changing operation must target only the current active note: ${context.activePath ?? "(none)"}.`,
      "If the active file is a .mindzj mind map, node edits may target that active mind map with the mind map tools.",
      "Do not create, delete, rename, or modify another note unless the user explicitly names its vault-relative path.",
    );
  }
  return lines.join("\n");
}

async function chatCompletionRequest(
  config: AiProviderConfig,
  messages: ChatMessage[],
  apiKey: string | null,
  includeTools = true,
) {
  const family = inferProviderFamily(config);
  if (family === "anthropic") return chatCompletionAnthropic(config, messages, apiKey, includeTools);
  if (family === "gemini") return chatCompletionGemini(config, messages, apiKey, includeTools);
  return chatCompletionOpenAiCompatible(config, messages, apiKey, includeTools);
}

function authHeader(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function postAiJson(url: string, headers: Record<string, string>, body: unknown) {
  try {
    return await invoke<any>("ai_chat_completion", {
      request: { url, headers, body },
    });
  } catch (error) {
    throw new Error(formatAiProviderError(error));
  }
}

async function getAiJson(url: string, headers: Record<string, string>) {
  try {
    return await invoke<any>("ai_get_json", {
      request: { url, headers },
    });
  } catch (error) {
    throw new Error(formatAiProviderError(error));
  }
}

async function postAiAudioTranscription(
  url: string,
  headers: Record<string, string>,
  fileName: string,
  mimeType: string,
  base64Data: string,
) {
  try {
    return await invoke<any>("ai_transcribe_audio", {
      request: { url, headers, fileName, mimeType, base64Data },
    });
  } catch (error) {
    throw new Error(formatAiProviderError(error));
  }
}

async function postAiTextToSpeech(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  outputDir: string | null,
  fileName: string,
): Promise<AiTextToSpeechResult> {
  try {
    return await invoke<AiTextToSpeechResult>("ai_text_to_speech", {
      request: { url, headers, body, outputDir, fileName },
    });
  } catch (error) {
    throw new Error(formatAiProviderError(error));
  }
}

function padAudioTimestamp(value: number): string {
  return String(value).padStart(2, "0");
}

function audioExportFileName(): string {
  const now = new Date();
  return [
    "mindzj_grok_tts_",
    now.getFullYear(),
    padAudioTimestamp(now.getMonth() + 1),
    padAudioTimestamp(now.getDate()),
    "_",
    padAudioTimestamp(now.getHours()),
    padAudioTimestamp(now.getMinutes()),
    padAudioTimestamp(now.getSeconds()),
    ".mp3",
  ].join("");
}

function parseProviderErrorPayload(raw: string): { status?: string; message: string; code?: string; type?: string; param?: string | null } {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(\d{3})(?::\s*)?([\s\S]*)$/);
  const status = match?.[1];
  const body = (match?.[2] ?? trimmed).trim();
  if (!body) return { status, message: trimmed };
  try {
    const parsed = JSON.parse(body);
    const error = parsed?.error ?? parsed;
    return {
      status,
      message: String(error?.message ?? parsed?.message ?? body),
      code: error?.code != null ? String(error.code) : parsed?.code != null ? String(parsed.code) : undefined,
      type: error?.type != null ? String(error.type) : undefined,
      param: error?.param ?? null,
    };
  } catch {
    const message = body
      .replace(/^\{|\}$/g, "")
      .replace(/\bmessage\s*:\s*/i, "")
      .replace(/\bstatus\s*:\s*/i, "status: ")
      .trim();
    return { status, message: message || trimmed };
  }
}

function formatAiProviderError(error: any): string {
  const raw = String(error?.message ?? error ?? "").trim();
  const payload = parseProviderErrorPayload(raw);
  const lower = payload.message.toLowerCase();
  const status = payload.status ? `${payload.status}: ` : "";
  let hint = "";
  if (lower.includes("generatecontentrequest.model") || lower.includes("unexpected model name format")) {
    hint = " Gemini 模型名格式不正确。请填写类似 gemini-1.5-flash、gemini-2.0-flash 或 models/gemini-2.0-flash 的模型名，不要填写完整 URL。";
  } else if (lower.includes("invalid model id") || lower.includes("invalid model")) {
    hint = " 模型 ID 无效。请确认模型名、API Key 和 endpoint 属于同一家服务；OpenAI/xAI 通常不要使用 models/ 前缀。";
  }
  return `${status}${payload.message}${hint}`.trim();
}

function parseModelIds(data: any): string[] {
  const raw = Array.isArray(data?.data)
    ? data.data
    : Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data)
        ? data
        : [];
  const ids = raw
    .map((item: any) => {
      if (typeof item === "string") return item;
      return String(item?.id ?? item?.name ?? item?.model ?? "").trim();
    })
    .filter(Boolean);
  return Array.from(new Set(ids));
}

async function listProviderModels(config: AiProviderConfig, apiKey: string | null): Promise<string[]> {
  const data = await getAiJson(`${providerBaseUrl(config)}/models`, authHeader(apiKey));
  return parseModelIds(data);
}

async function chatCompletionOpenAiCompatible(
  config: AiProviderConfig,
  messages: ChatMessage[],
  apiKey: string | null,
  includeTools = true,
) {
  return postAiJson(
    `${providerBaseUrl(config)}/chat/completions`,
    authHeader(apiKey),
    {
      model: openAiCompatibleModelId(config),
      messages,
      ...(includeTools ? { tools: TOOLS, tool_choice: "auto" } : {}),
    },
  );
}

function anthropicToolDefinitions() {
  return TOOLS.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function anthropicMessages(messages: ChatMessage[]) {
  const system: string[] = [];
  const result: any[] = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) system.push(message.content);
      continue;
    }
    if (message.role === "user") {
      result.push({ role: "user", content: message.content ?? "" });
      continue;
    }
    if (message.role === "assistant") {
      const content: any[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name);
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: parseJsonObject(call.function.arguments) ?? {},
        });
      }
      result.push({ role: "assistant", content: content.length ? content : "" });
      continue;
    }
    if (message.role === "tool" && message.tool_call_id) {
      result.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: message.content ?? "",
        }],
      });
    }
  }

  return { system: system.join("\n\n"), messages: result };
}

function normalizeAnthropicResponse(data: any) {
  const parts = Array.isArray(data?.content) ? data.content : [];
  const text = parts
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
  const toolCalls = parts
    .filter((part: any) => part?.type === "tool_use" && part.name)
    .map((part: any, index: number) => ({
      id: String(part.id ?? `anthropic-tool-${index}`),
      type: "function" as const,
      function: {
        name: String(part.name),
        arguments: JSON.stringify(part.input ?? {}),
      },
    }));
  return {
    choices: [{
      message: {
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
    }],
  };
}

async function chatCompletionAnthropic(
  config: AiProviderConfig,
  messages: ChatMessage[],
  apiKey: string | null,
  includeTools = true,
) {
  if (!apiKey) throw new Error("API key is required for this provider.");
  const converted = anthropicMessages(messages);
  const data = await postAiJson(
    `${providerBaseUrl(config)}/messages`,
    {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    {
      model: config.model,
      max_tokens: 4096,
      system: converted.system,
      messages: converted.messages,
      ...(includeTools ? { tools: anthropicToolDefinitions() } : {}),
    },
  );
  return normalizeAnthropicResponse(data);
}

function toGeminiSchema(value: any): any {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "additionalProperties") continue;
    result[key] = key === "type" && typeof entry === "string"
      ? entry.toUpperCase()
      : toGeminiSchema(entry);
  }
  return result;
}

function geminiToolDefinitions() {
  return [{
    functionDeclarations: TOOLS.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: toGeminiSchema(tool.function.parameters),
    })),
  }];
}

function geminiModelPath(model: string): string {
  let id = stripCopiedModelPath(model)
    .replace(/^models\//i, "")
    .replace(/^(?:google|gemini)\//i, "");
  if (id.includes("/")) {
    const last = id.split("/").filter(Boolean).pop();
    if (last?.toLowerCase().startsWith("gemini-")) id = last;
  }
  return `models/${id}`;
}

function geminiMessages(messages: ChatMessage[]) {
  const systemParts: Array<{ text: string }> = [];
  const contents: any[] = [];
  const toolNames = new Map<string, string>();

  for (const message of messages) {
    if (message.role === "system") {
      if (message.content) systemParts.push({ text: message.content });
      continue;
    }
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content ?? "" }] });
      continue;
    }
    if (message.role === "assistant") {
      const parts: any[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.tool_calls ?? []) {
        toolNames.set(call.id, call.function.name);
        parts.push({
          functionCall: {
            name: call.function.name,
            args: parseJsonObject(call.function.arguments) ?? {},
          },
        });
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    if (message.role === "tool" && message.tool_call_id) {
      const toolName = toolNames.get(message.tool_call_id) ?? "tool_result";
      const parsed = message.content ? parseJsonObject(message.content) : null;
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            name: toolName,
            response: parsed ?? { content: message.content ?? "" },
          },
        }],
      });
    }
  }

  return {
    systemInstruction: systemParts.length ? { parts: systemParts } : undefined,
    contents,
  };
}

function normalizeGeminiResponse(data: any) {
  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((part: any) => typeof part?.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
  const toolCalls = parts
    .filter((part: any) => part?.functionCall?.name)
    .map((part: any, index: number) => ({
      id: `gemini-tool-${index}`,
      type: "function" as const,
      function: {
        name: String(part.functionCall.name),
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      },
    }));
  return {
    choices: [{
      message: {
        content: text || null,
        tool_calls: toolCalls.length ? toolCalls : undefined,
      },
    }],
  };
}

async function chatCompletionGemini(
  config: AiProviderConfig,
  messages: ChatMessage[],
  apiKey: string | null,
  includeTools = true,
) {
  if (!apiKey) throw new Error("API key is required for this provider.");
  const converted = geminiMessages(messages);
  const data = await postAiJson(
    `${providerBaseUrl(config)}/${geminiModelPath(config.model)}:generateContent`,
    { "x-goog-api-key": apiKey },
    {
      ...converted,
      ...(includeTools
        ? {
            tools: geminiToolDefinitions(),
            toolConfig: { functionCallingConfig: { mode: "AUTO" } },
          }
        : {}),
    },
  );
  return normalizeGeminiResponse(data);
}

async function runJsonFallback(content: string, context?: ToolExecutionContext): Promise<string | null> {
  const parsed = parseJsonObject(content);
  if (!parsed) return null;
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [parsed];
  const results: ToolResult[] = [];
  for (const action of actions) {
    if (!action?.tool) continue;
    results.push(await executeTool(action.tool, action.arguments ?? {}, context));
  }
  if (!results.length) return null;
  return results.map((result) => result.message || JSON.stringify(result.data ?? result)).join("\n");
}

function createAiStore() {
  async function getApiKey(config: AiProviderConfig): Promise<string | null> {
    if (!providerNeedsRealKey(config.provider_type)) return null;
    const value = config.api_key?.trim();
    if (value) return value;
    const provider = providerStorageId(config);
    const migrated = await invoke<string | null>("get_ai_api_key", { provider }).catch(() => null);
    if (migrated?.trim()) {
      await saveApiKey(provider, migrated);
      return migrated.trim();
    }
    return null;
  }

  async function saveApiKey(provider: string, apiKey: string): Promise<void> {
    const value = apiKey.trim();
    const hasApiKey = value.length > 0;
    const updateConfig = (config: AiProviderConfig): AiProviderConfig =>
      configMatchesProvider(config, provider)
        ? { ...config, api_key: value || null, has_api_key: hasApiKey }
        : config;
    const current = settingsStore.settings();
    const nextProvider = current.ai_provider ? updateConfig(current.ai_provider) : current.ai_provider;
    const nextCustomProviders = (current.ai_custom_providers ?? []).map(updateConfig);
    await settingsStore.updateSetting("ai_custom_providers", nextCustomProviders);
    await settingsStore.updateSetting("ai_provider", nextProvider);
  }

  async function loadApiKey(config = configuredProvider()): Promise<string | null> {
    if (!config) return null;
    return getApiKey(config);
  }

  function isConfigured(): boolean {
    const config = configuredProvider();
    if (!config?.model || !providerBaseUrl(config)) return false;
    return !providerNeedsRealKey(config.provider_type) || config.has_api_key;
  }

  function currentModelLabel(): string {
    return aiProviderModelLabel(configuredProvider());
  }

  async function testConnection(config = configuredProvider()): Promise<AiConnectionTestResult> {
    if (!config) throw new Error("AI provider is not configured.");
    if (!providerBaseUrl(config)) throw new Error("AI endpoint is empty.");

    const apiKey = await getApiKey(config);
    if (providerNeedsRealKey(config.provider_type)) {
      if (!config.model.trim()) throw new Error("AI model is empty.");
      if (!config.has_api_key || !apiKey) throw new Error("API key is required for this provider.");
      const data = await chatCompletionRequest(
        config,
        [{ role: "user", content: "Reply with OK." }],
        apiKey,
        false,
      );
      const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
      return { model: config.display_name || config.model, content: content || null };
    }

    const models = await listProviderModels(config, apiKey);
    const detectedModel = models[0] || config.model.trim();
    if (!detectedModel) throw new Error("AI provider returned no available models.");

    const current = settingsStore.settings().ai_provider ?? config;
    const next: AiProviderConfig = {
      ...current,
      ...config,
      model: detectedModel,
    };
    await settingsStore.updateSetting("ai_provider", next);
    return { model: detectedModel, models };
  }

  async function runInstruction(instruction: string, options?: RunInstructionOptions): Promise<string> {
    const config = configuredProvider();
    if (!config) throw new Error("AI provider is not configured.");
    if (!config.model.trim()) throw new Error("AI model is empty.");
    if (!providerBaseUrl(config)) throw new Error("AI endpoint is empty.");
    if (providerNeedsRealKey(config.provider_type) && !config.has_api_key) {
      throw new Error("API key is required for this provider.");
    }

    const apiKey = await getApiKey(config);
    if (providerNeedsRealKey(config.provider_type) && !apiKey) {
      throw new Error("API key is required for this provider.");
    }
    await editorStore.flushAllPendingSaves();
    const toolContext = buildToolContext(instruction, options);
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt(toolContext, config) },
      { role: "user", content: instruction },
    ];
    const executed: string[] = [];

    for (let step = 0; step < 8; step++) {
      emitProgress(options, "request", step === 0 ? "Sending instruction to AI model." : "Sending tool results back to AI model.");
      const data = await chatCompletionRequest(config, messages, apiKey);
      const choice = data?.choices?.[0];
      const message = choice?.message;
      const finishReason = String(choice?.finish_reason ?? "");
      if (!message) throw new Error("AI provider returned an empty response.");
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: message.tool_calls,
      });

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls as ToolCall[] : [];
      if (toolCalls.length > 0) {
        for (const call of toolCalls) {
          const args = parseJsonObject(call.function.arguments) ?? {};
          emitProgress(options, "tool-call", `Calling ${summarizeToolCall(call.function.name, args)}.`);
          const result = await executeTool(call.function.name, args, toolContext);
          if (result.message) executed.push(result.message);
          emitProgress(
            options,
            result.ok ? "tool-result" : "error",
            result.message || (result.ok ? `${call.function.name} completed.` : `${call.function.name} failed.`),
          );
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      const content = String(message.content ?? "").trim();
      const fallback = await runJsonFallback(content, toolContext);
      if (fallback) {
        emitProgress(options, "done", fallback);
        return fallback;
      }
      if (finishReason === "length") {
        const result = executed.join("\n") || "AI response was truncated before it produced a note action.";
        emitProgress(options, "error", result);
        return result;
      }
      const naturalWriteFallback = await appendNaturalResponseToActiveNote(instruction, content, toolContext);
      if (naturalWriteFallback) {
        emitProgress(options, "done", naturalWriteFallback);
        return naturalWriteFallback;
      }
      if (looksLikeToolFailureSummary(content) && executed.length) {
        const result = executed.join("\n");
        emitProgress(options, "error", result);
        return result;
      }
      const result = content || executed.join("\n") || "Done.";
      emitProgress(options, "done", result);
      return result;
    }

    const result = executed.join("\n") || "AI tool loop reached the step limit.";
    emitProgress(options, "error", result);
    return result;
  }

  async function transcribeGrokAudio(
    base64Data: string,
    fileName: string,
    mimeType: string,
  ): Promise<string> {
    const config = configuredGrokProvider();
    const apiKey = await getApiKey(config);
    if (!apiKey) throw new Error("Grok API key is required for speech-to-text.");
    const data = await postAiAudioTranscription(
      `${providerBaseUrl(config)}/stt`,
      authHeader(apiKey),
      fileName,
      mimeType || "audio/wav",
      base64Data,
    );
    return String(data?.text ?? "").trim();
  }

  async function synthesizeGrokSpeech(text: string): Promise<AiTextToSpeechResult> {
    const input = text.trim();
    if (!input) throw new Error("Text is required for speech export.");
    if (input.length > 15000) throw new Error("xAI TTS text must be 15,000 characters or fewer.");

    const config = configuredGrokProvider();
    const apiKey = await getApiKey(config);
    if (!apiKey) throw new Error("Grok API key is required for text-to-speech.");
    const settings = settingsStore.settings();
    const voice = settings.ai_tts_voice?.trim() || "eve";
    const language = settings.ai_tts_language?.trim() || "auto";
    return postAiTextToSpeech(
      `${providerBaseUrl(config)}/tts`,
      authHeader(apiKey),
      {
        text: input,
        voice_id: voice,
        language,
        output_format: { codec: "mp3" },
      },
      settings.ai_voice_export_folder?.trim() || null,
      audioExportFileName(),
    );
  }

  return {
    defaultAiProviderConfig,
    isConfigured,
    currentModelLabel,
    saveApiKey,
    loadApiKey,
    testConnection,
    runInstruction,
    transcribeGrokAudio,
    synthesizeGrokSpeech,
  };
}

export const aiStore = createAiStore();

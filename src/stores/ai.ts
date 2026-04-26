import { invoke } from "@tauri-apps/api/core";
import { editorStore, type ViewMode } from "./editor";
import { aiModelSettingsKey, settingsStore, type AiProviderConfig, type AiProviderType, type AiSkill, type AppSettings } from "./settings";
import { vaultStore, type VaultEntry, type FileContent } from "./vault";
import { listPluginCommands, runPluginCommand } from "./plugins";

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

const PROVIDER_DEFAULTS: Record<"Ollama" | "LMStudio" | "ApiKeyLLM", AiProviderConfig> = {
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
};

function cloneConfig(config: AiProviderConfig): AiProviderConfig {
  return { ...config };
}

function normalizeProviderType(provider: AiProviderType): "Ollama" | "LMStudio" | "ApiKeyLLM" {
  return provider === "Ollama" || provider === "LMStudio" ? provider : "ApiKeyLLM";
}

function providerDisplayName(config: AiProviderConfig): string {
  const providerType = normalizeProviderType(config.provider_type);
  if (providerType === "LMStudio") return "LM Studio";
  if (providerType === "Ollama") return "Ollama";
  return "Online LLM";
}

export function defaultAiProviderConfig(provider: AiProviderType): AiProviderConfig {
  return cloneConfig(PROVIDER_DEFAULTS[normalizeProviderType(provider)]);
}

function configuredProvider(): AiProviderConfig | null {
  return settingsStore.settings().ai_provider ?? defaultAiProviderConfig("Ollama");
}

function providerBaseUrl(config: AiProviderConfig): string {
  const providerType = normalizeProviderType(config.provider_type);
  const fallback = providerType === "ApiKeyLLM"
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
  const family = inferProviderFamily(config);
  if (family === "anthropic") return "https://api.anthropic.com/v1";
  if (family === "gemini") return "https://generativelanguage.googleapis.com/v1beta";
  if (modelHint(config).includes("grok") || modelHint(config).includes("xai")) {
    return "https://api.x.ai/v1";
  }
  return "https://api.openai.com/v1";
}

function providerNeedsRealKey(provider: AiProviderType): boolean {
  return normalizeProviderType(provider) === "ApiKeyLLM";
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

const NOTE_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    path: { type: "string", description: "Vault-relative path, for example notes/today.md" },
  },
  required: ["path"],
  additionalProperties: false,
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
  return /\.md\b/i.test(text)
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
    "If the user asks you to translate, draft, summarize, rewrite, polish, generate, or record content, write the result into the target note with create_note, update_note, or append_note.",
    "If the user did not name a target note, write content changes to the active note.",
    "For destructive changes, only perform the exact action requested by the user.",
    "If a note already exists, update it with the requested content instead of writing a troubleshooting report.",
    "If a tool fails, report the exact failure in one short sentence. Do not produce long summaries or solution lists.",
    "When you finish, summarize what you changed in one concise sentence.",
    `Active note: ${active}`,
    `Available plugin command ids: ${commands.join(", ") || "(none)"}`,
    "If tool calling is unavailable, respond with JSON like {\"tool\":\"read_note\",\"arguments\":{\"path\":\"note.md\"}} or {\"actions\":[...]} only.",
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
    const config = configuredProvider();
    if (!config) return "Ollama";
    const provider = providerDisplayName(config);
    const model = (config.display_name || config.model || "").trim();
    return model ? `${provider} · ${model}` : provider;
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

  return {
    defaultAiProviderConfig,
    isConfigured,
    currentModelLabel,
    saveApiKey,
    loadApiKey,
    testConnection,
    runInstruction,
  };
}

export const aiStore = createAiStore();

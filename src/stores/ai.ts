import { invoke } from "@tauri-apps/api/core";
import { editorStore, type ViewMode } from "./editor";
import { settingsStore, type AiProviderConfig, type AiProviderType, type AppSettings } from "./settings";
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

const PROVIDER_DEFAULTS: Record<AiProviderType, AiProviderConfig> = {
  OpenAI: {
    provider_type: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    has_api_key: false,
    model: "gpt-5-mini",
  },
  Ollama: {
    provider_type: "Ollama",
    endpoint: "http://localhost:11434/v1",
    has_api_key: false,
    model: "llama3.2",
  },
  LMStudio: {
    provider_type: "LMStudio",
    endpoint: "http://localhost:1234/v1",
    has_api_key: false,
    model: "local-model",
  },
  Claude: {
    provider_type: "Claude",
    endpoint: null,
    has_api_key: false,
    model: "claude-sonnet",
  },
  Custom: {
    provider_type: "Custom",
    endpoint: "http://localhost:1234/v1",
    has_api_key: false,
    model: "local-model",
  },
};

function cloneConfig(config: AiProviderConfig): AiProviderConfig {
  return { ...config };
}

export function defaultAiProviderConfig(provider: AiProviderType): AiProviderConfig {
  return cloneConfig(PROVIDER_DEFAULTS[provider]);
}

function configuredProvider(): AiProviderConfig | null {
  return settingsStore.settings().ai_provider ?? defaultAiProviderConfig("Ollama");
}

function providerBaseUrl(config: AiProviderConfig): string {
  const fallback = PROVIDER_DEFAULTS[config.provider_type]?.endpoint ?? "";
  return (config.endpoint || fallback || "").replace(/\/+$/, "");
}

function providerNeedsRealKey(provider: AiProviderType): boolean {
  return provider === "OpenAI" || provider === "Claude";
}

function placeholderApiKey(provider: AiProviderType): string {
  if (provider === "Ollama") return "ollama";
  if (provider === "LMStudio") return "lm-studio";
  return "local";
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

async function executeTool(name: string, args: any): Promise<ToolResult> {
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
        const file = await invoke<FileContent>("read_file", { relativePath: path });
        return { ok: true, data: { path: file.path, content: file.content } };
      }
      case "create_note": {
        const path = cleanPath(String(args.path ?? ""));
        const content = String(args.content ?? "");
        const file = await vaultStore.createFile(path, content);
        await vaultStore.openFile(file.path);
        return { ok: true, message: `Created ${file.path}`, data: file };
      }
      case "update_note": {
        const path = cleanPath(String(args.path ?? ""));
        const content = String(args.content ?? "");
        const file = await vaultStore.saveFile(path, content);
        return { ok: true, message: `Updated ${file.path}`, data: file };
      }
      case "append_note": {
        const path = cleanPath(String(args.path ?? ""));
        const content = String(args.content ?? "");
        const file = await invoke<FileContent>("read_file", { relativePath: path });
        const next = file.content.endsWith("\n") || content.startsWith("\n")
          ? `${file.content}${content}`
          : `${file.content}\n${content}`;
        const saved = await vaultStore.saveFile(path, next);
        return { ok: true, message: `Appended to ${saved.path}`, data: saved };
      }
      case "delete_note": {
        const path = cleanPath(String(args.path ?? ""));
        await vaultStore.deleteFile(path);
        return { ok: true, message: `Deleted ${path}` };
      }
      case "delete_folder": {
        const path = cleanPath(String(args.path ?? ""));
        await vaultStore.deleteDir(path);
        return { ok: true, message: `Deleted folder ${path}` };
      }
      case "rename_note": {
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
        const links = await invoke("get_backlinks", { relativePath: path });
        return { ok: true, data: links };
      }
      case "get_forward_links": {
        const path = cleanPath(String(args.path ?? ""));
        const links = await invoke("get_forward_links", { relativePath: path });
        return { ok: true, data: links };
      }
      case "get_graph_data": {
        const graph = await invoke("get_graph_data");
        return { ok: true, data: graph };
      }
      case "open_note": {
        const path = cleanPath(String(args.path ?? ""));
        const file = await vaultStore.openFile(path);
        return { ok: true, message: `Opened ${file.path}`, data: { path: file.path } };
      }
      case "create_folder": {
        const path = cleanPath(String(args.path ?? ""));
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

function buildSystemPrompt() {
  const active = vaultStore.activeFile()?.path ?? "(none)";
  const commands = listPluginCommands().map((command) => command.id).slice(0, 80);
  return [
    "You are MindZJ's local automation agent.",
    "Use tools to inspect and modify the user's current vault. Do not invent file contents or paths.",
    "For destructive changes, only perform the exact action requested by the user.",
    "When you finish, summarize what you changed in one concise sentence.",
    `Active note: ${active}`,
    `Available plugin command ids: ${commands.join(", ") || "(none)"}`,
    "If tool calling is unavailable, respond with JSON like {\"tool\":\"read_note\",\"arguments\":{\"path\":\"note.md\"}} or {\"actions\":[...]} only.",
  ].join("\n");
}

async function chatCompletionRequest(
  config: AiProviderConfig,
  messages: ChatMessage[],
  apiKey: string,
) {
  const url = `${providerBaseUrl(config)}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
  }
  return response.json();
}

async function runJsonFallback(content: string): Promise<string | null> {
  const parsed = parseJsonObject(content);
  if (!parsed) return null;
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [parsed];
  const results: ToolResult[] = [];
  for (const action of actions) {
    if (!action?.tool) continue;
    results.push(await executeTool(action.tool, action.arguments ?? {}));
  }
  if (!results.length) return null;
  return results.map((result) => result.message || JSON.stringify(result.data ?? result)).join("\n");
}

function createAiStore() {
  async function getApiKey(provider: AiProviderType): Promise<string> {
    const stored = await invoke<string | null>("get_ai_api_key", { provider }).catch(() => null);
    if (stored) return stored;
    return placeholderApiKey(provider);
  }

  async function saveApiKey(provider: AiProviderType, apiKey: string): Promise<void> {
    await invoke("set_ai_api_key", { provider, apiKey });
  }

  function isConfigured(): boolean {
    const config = configuredProvider();
    if (!config?.model || !providerBaseUrl(config)) return false;
    return !providerNeedsRealKey(config.provider_type) || config.has_api_key;
  }

  async function runInstruction(instruction: string): Promise<string> {
    const config = configuredProvider();
    if (!config) throw new Error("AI provider is not configured.");
    if (!config.model.trim()) throw new Error("AI model is empty.");
    if (!providerBaseUrl(config)) throw new Error("AI endpoint is empty.");
    if (providerNeedsRealKey(config.provider_type) && !config.has_api_key) {
      throw new Error("API key is required for this provider.");
    }

    const apiKey = await getApiKey(config.provider_type);
    const messages: ChatMessage[] = [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: instruction },
    ];
    const executed: string[] = [];

    for (let step = 0; step < 8; step++) {
      const data = await chatCompletionRequest(config, messages, apiKey);
      const message = data?.choices?.[0]?.message;
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
          const result = await executeTool(call.function.name, args);
          if (result.message) executed.push(result.message);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      const content = String(message.content ?? "").trim();
      const fallback = await runJsonFallback(content);
      if (fallback) return fallback;
      return content || executed.join("\n") || "Done.";
    }

    return executed.join("\n") || "AI tool loop reached the step limit.";
  }

  return {
    defaultAiProviderConfig,
    isConfigured,
    saveApiKey,
    runInstruction,
  };
}

export const aiStore = createAiStore();

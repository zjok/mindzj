/**
 * MindZJ Plugin API
 *
 * This module defines the public API surface available to plugins
 * running inside the WebWorker sandbox. Plugins communicate with
 * the main application exclusively through this typed interface.
 *
 * SECURITY: Plugins cannot access the DOM, filesystem, or network
 * directly. Every capability requires a declared permission.
 */

// ---------------------------------------------------------------------------
// Core plugin types
// ---------------------------------------------------------------------------

export interface PluginManifest {
  /** Unique plugin identifier (reverse-domain, e.g. "com.example.myplugin") */
  id: string;
  /** Display name */
  name: string;
  /** Semantic version */
  version: string;
  /** Author name or organization */
  author: string;
  /** Short description */
  description: string;
  /** Minimum MindZJ version required */
  minAppVersion: string;
  /** Permissions the plugin requires */
  permissions: PluginPermission[];
  /** Entry point file (relative to plugin directory) */
  main: string;
}

export type PluginPermission =
  | "vault:read"        // Read files from the vault
  | "vault:write"       // Write/create/delete files
  | "vault:watch"       // Watch for file changes
  | "editor:read"       // Read editor state (selection, content)
  | "editor:modify"     // Modify editor content
  | "ui:sidebar"        // Add a sidebar panel
  | "ui:command"        // Register commands in the palette
  | "ui:statusbar"      // Add status bar items
  | "ui:settings"       // Add a settings tab
  | "ui:notice"         // Show notifications
  | "search:query"      // Execute search queries
  | "links:read"        // Read link graph data
  | "ai:invoke"         // Call AI providers (requires user consent)
  | "network:fetch";    // Make HTTP requests (requires user consent)

// ---------------------------------------------------------------------------
// Vault API (available with vault:read / vault:write)
// ---------------------------------------------------------------------------

export interface PluginVaultAPI {
  /** Read the content of a file */
  readFile(path: string): Promise<string>;
  /** Write content to a file (creates if doesn't exist) */
  writeFile(path: string, content: string): Promise<void>;
  /** Check if a file exists */
  exists(path: string): Promise<boolean>;
  /** List files in a directory */
  listFiles(dir: string): Promise<string[]>;
  /** Delete a file */
  deleteFile(path: string): Promise<void>;
  /** Get file metadata */
  getMetadata(path: string): Promise<FileMetadataAPI>;
}

export interface FileMetadataAPI {
  path: string;
  size: number;
  modified: string;
  tags: string[];
  wordCount: number;
}

// ---------------------------------------------------------------------------
// Editor API (available with editor:read / editor:modify)
// ---------------------------------------------------------------------------

export interface PluginEditorAPI {
  /** Get the current editor content */
  getContent(): Promise<string>;
  /** Get the currently selected text */
  getSelection(): Promise<string>;
  /** Replace the current selection with new text */
  replaceSelection(text: string): Promise<void>;
  /** Insert text at the current cursor position */
  insertAtCursor(text: string): Promise<void>;
  /** Get the cursor position */
  getCursorPosition(): Promise<{ line: number; col: number }>;
  /** Set the cursor position */
  setCursorPosition(line: number, col: number): Promise<void>;
  /** Get the path of the currently active file */
  getActiveFilePath(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// UI API (available with various ui:* permissions)
// ---------------------------------------------------------------------------

export interface PluginUIAPI {
  /** Register a command in the command palette */
  addCommand(config: CommandConfig): void;
  /** Show a notice/toast message */
  showNotice(message: string, duration?: number): void;
  /** Add an item to the status bar */
  addStatusBarItem(config: StatusBarItemConfig): StatusBarItemHandle;
  /** Register a settings tab for the plugin */
  addSettingTab(config: SettingTabConfig): void;
  /** Register a sidebar panel */
  addSidebarPanel(config: SidebarPanelConfig): void;
}

export interface CommandConfig {
  id: string;
  name: string;
  /** Optional keyboard shortcut (e.g. "Ctrl+Shift+T") */
  hotkey?: string;
  callback: () => void | Promise<void>;
}

export interface StatusBarItemConfig {
  id: string;
  text: string;
  tooltip?: string;
  onClick?: () => void;
}

export interface StatusBarItemHandle {
  setText(text: string): void;
  remove(): void;
}

export interface SettingTabConfig {
  id: string;
  name: string;
  /** Render function that returns HTML string for the settings panel */
  render: () => string;
  /** Called when settings are saved */
  onSave?: (data: Record<string, unknown>) => void;
}

export interface SidebarPanelConfig {
  id: string;
  name: string;
  icon: string;
  /** Render function returning HTML for the panel */
  render: () => string;
}

// ---------------------------------------------------------------------------
// Search API (available with search:query)
// ---------------------------------------------------------------------------

export interface PluginSearchAPI {
  /** Execute a full-text search */
  search(query: string, limit?: number): Promise<SearchResultAPI[]>;
}

export interface SearchResultAPI {
  path: string;
  fileName: string;
  snippets: { text: string; line: number }[];
  score: number;
}

// ---------------------------------------------------------------------------
// Links API (available with links:read)
// ---------------------------------------------------------------------------

export interface PluginLinksAPI {
  /** Get all backlinks to a file */
  getBacklinks(path: string): Promise<LinkAPI[]>;
  /** Get all outgoing links from a file */
  getForwardLinks(path: string): Promise<LinkAPI[]>;
  /** Get the full graph data */
  getGraphData(): Promise<{ nodes: GraphNodeAPI[]; edges: GraphEdgeAPI[] }>;
}

export interface LinkAPI {
  source: string;
  target: string;
  displayText?: string;
  type: "wikilink" | "markdown" | "embed";
  line: number;
}

export interface GraphNodeAPI {
  id: string;
  label: string;
  backlinkCount: number;
}

export interface GraphEdgeAPI {
  source: string;
  target: string;
}

// ---------------------------------------------------------------------------
// AI API (available with ai:invoke — requires explicit user consent)
// ---------------------------------------------------------------------------

export interface PluginAIAPI {
  /** Send a completion request to the configured AI provider */
  complete(prompt: string, options?: AIRequestOptions): Promise<string>;
  /** Check if an AI provider is configured */
  isAvailable(): Promise<boolean>;
}

export interface AIRequestOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Plugin base class
// ---------------------------------------------------------------------------

export interface MindZJPluginContext {
  vault: PluginVaultAPI;
  editor: PluginEditorAPI;
  ui: PluginUIAPI;
  search: PluginSearchAPI;
  links: PluginLinksAPI;
  ai: PluginAIAPI;
  /** The plugin's manifest */
  manifest: PluginManifest;
  /** Persistent storage scoped to this plugin */
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

/**
 * Base class for MindZJ plugins.
 *
 * Example usage:
 * ```ts
 * export default class MyPlugin implements MindZJPlugin {
 *   onLoad(ctx: MindZJPluginContext) {
 *     ctx.ui.addCommand({
 *       id: "my-command",
 *       name: "My Command",
 *       callback: async () => {
 *         const content = await ctx.editor.getContent();
 *         ctx.ui.showNotice(`File has ${content.length} characters`);
 *       },
 *     });
 *   }
 *
 *   onUnload() {
 *     // Cleanup
 *   }
 * }
 * ```
 */
export interface MindZJPlugin {
  /** Called when the plugin is loaded */
  onLoad(ctx: MindZJPluginContext): void | Promise<void>;
  /** Called when the plugin is unloaded */
  onUnload(): void | Promise<void>;
}

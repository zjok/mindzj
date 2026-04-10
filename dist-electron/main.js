"use strict";
var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const chokidar = require("chokidar");
const HIDDEN_DIRS = /* @__PURE__ */ new Set([".mindzj", ".git", ".obsidian", ".trash", "node_modules"]);
const FORBIDDEN_CHARS = /[<>:"|?*\x00-\x1f]/;
const MAX_SNAPSHOTS_PER_FILE = 50;
class Vault {
  constructor(vaultPath) {
    __publicField(this, "root");
    __publicField(this, "configDir");
    __publicField(this, "selfWrites", /* @__PURE__ */ new Set());
    this.root = path.resolve(vaultPath);
    this.configDir = path.join(this.root, ".mindzj");
    this.ensureConfigStructure();
  }
  // ─── Path Safety ───
  resolveSafePath(relativePath) {
    const normalized = path.normalize(relativePath);
    if (normalized.includes("..")) {
      throw new Error(`Path traversal denied: ${relativePath}`);
    }
    const resolved = path.resolve(this.root, normalized);
    if (!resolved.startsWith(this.root)) {
      throw new Error(`Path traversal denied: ${relativePath}`);
    }
    return resolved;
  }
  validateFileName(name) {
    if (!name || name.trim().length === 0) {
      throw new Error("File name cannot be empty");
    }
    if (FORBIDDEN_CHARS.test(name)) {
      throw new Error(`Invalid characters in file name: ${name}`);
    }
  }
  // ─── Config Structure ───
  ensureConfigStructure() {
    const dirs = [
      this.configDir,
      path.join(this.configDir, "snapshots"),
      path.join(this.configDir, "plugins"),
      path.join(this.configDir, "snippets"),
      path.join(this.configDir, "themes")
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    const defaults = {
      "settings.json": {},
      "workspace.json": {},
      "hotkeys.json": [],
      "plugins.json": { enabled: [] }
    };
    for (const [name, defaultValue] of Object.entries(defaults)) {
      const filePath = path.join(this.configDir, name);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
      }
    }
  }
  // ─── File Operations ───
  async readFile(relativePath) {
    const absPath = this.resolveSafePath(relativePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    const content = fs.readFileSync(absPath, "utf-8");
    const stat = fs.statSync(absPath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return {
      path: relativePath,
      content,
      modified: stat.mtime.toISOString(),
      hash
    };
  }
  async writeFile(relativePath, content) {
    const absPath = this.resolveSafePath(relativePath);
    if (fs.existsSync(absPath)) {
      this.createSnapshot(relativePath);
    }
    await this.atomicWrite(absPath, content);
    this.selfWrites.add(relativePath);
    setTimeout(() => this.selfWrites.delete(relativePath), 500);
    const stat = fs.statSync(absPath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return {
      path: relativePath,
      content,
      modified: stat.mtime.toISOString(),
      hash
    };
  }
  async createFile(relativePath, content) {
    const absPath = this.resolveSafePath(relativePath);
    const dir = path.dirname(absPath);
    const baseName = path.basename(relativePath);
    this.validateFileName(baseName);
    if (fs.existsSync(absPath)) {
      throw new Error(`File already exists: ${relativePath}`);
    }
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await this.atomicWrite(absPath, content);
    this.selfWrites.add(relativePath);
    setTimeout(() => this.selfWrites.delete(relativePath), 500);
    const stat = fs.statSync(absPath);
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    return {
      path: relativePath,
      content,
      modified: stat.mtime.toISOString(),
      hash
    };
  }
  async deleteFile(relativePath) {
    const absPath = this.resolveSafePath(relativePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`File not found: ${relativePath}`);
    }
    this.createSnapshot(relativePath);
    fs.unlinkSync(absPath);
  }
  async renameFile(from, to) {
    const fromAbs = this.resolveSafePath(from);
    const toAbs = this.resolveSafePath(to);
    const toDir = path.dirname(toAbs);
    this.validateFileName(path.basename(to));
    if (!fs.existsSync(fromAbs)) {
      throw new Error(`File not found: ${from}`);
    }
    if (fs.existsSync(toAbs)) {
      throw new Error(`Target already exists: ${to}`);
    }
    if (!fs.existsSync(toDir)) {
      fs.mkdirSync(toDir, { recursive: true });
    }
    fs.renameSync(fromAbs, toAbs);
  }
  async createDir(relativePath) {
    const absPath = this.resolveSafePath(relativePath);
    fs.mkdirSync(absPath, { recursive: true });
  }
  async deleteDir(relativePath, recursive) {
    const absPath = this.resolveSafePath(relativePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Directory not found: ${relativePath}`);
    }
    if (recursive) {
      fs.rmSync(absPath, { recursive: true, force: true });
    } else {
      fs.rmdirSync(absPath);
    }
  }
  // ─── Atomic Write ───
  async atomicWrite(absPath, content) {
    const dir = path.dirname(absPath);
    const tmpPath = path.join(dir, `.~${path.basename(absPath)}.tmp`);
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeSync(fd, content, 0, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, absPath);
  }
  // ─── Snapshots ───
  createSnapshot(relativePath) {
    try {
      const absPath = this.resolveSafePath(relativePath);
      if (!fs.existsSync(absPath)) return;
      const content = fs.readFileSync(absPath, "utf-8");
      const safeName = relativePath.replace(/[/\\]/g, "__");
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const snapshotName = `${safeName}__${timestamp}`;
      const snapshotPath = path.join(this.configDir, "snapshots", snapshotName);
      fs.writeFileSync(snapshotPath, content, "utf-8");
      this.pruneSnapshots(relativePath);
    } catch {
    }
  }
  pruneSnapshots(relativePath) {
    const safeName = relativePath.replace(/[/\\]/g, "__");
    const snapshotDir = path.join(this.configDir, "snapshots");
    const files = fs.readdirSync(snapshotDir).filter((f) => f.startsWith(safeName + "__")).sort();
    while (files.length > MAX_SNAPSHOTS_PER_FILE) {
      const oldest = files.shift();
      fs.unlinkSync(path.join(snapshotDir, oldest));
    }
  }
  listSnapshots(relativePath) {
    const safeName = relativePath.replace(/[/\\]/g, "__");
    const snapshotDir = path.join(this.configDir, "snapshots");
    if (!fs.existsSync(snapshotDir)) return [];
    return fs.readdirSync(snapshotDir).filter((f) => f.startsWith(safeName + "__")).sort().reverse();
  }
  async restoreSnapshot(relativePath, snapshotName) {
    const snapshotPath = path.join(this.configDir, "snapshots", snapshotName);
    if (!fs.existsSync(snapshotPath)) {
      throw new Error(`Snapshot not found: ${snapshotName}`);
    }
    const content = fs.readFileSync(snapshotPath, "utf-8");
    return this.writeFile(relativePath, content);
  }
  // ─── Directory Listing ───
  listEntries(dir = "") {
    const absDir = dir ? this.resolveSafePath(dir) : this.root;
    if (!fs.existsSync(absDir)) return [];
    return fs.readdirSync(absDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".") && !HIDDEN_DIRS.has(entry.name)).map((entry) => {
      const relPath = dir ? `${dir}/${entry.name}` : entry.name;
      const absPath = path.join(absDir, entry.name);
      const stat = fs.statSync(absPath);
      return {
        name: entry.name,
        path: relPath,
        is_dir: entry.isDirectory(),
        size: stat.size,
        modified: stat.mtime.toISOString(),
        extension: entry.isDirectory() ? "" : path.extname(entry.name).toLowerCase()
      };
    }).sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
  }
  getFileTree(maxDepth = 10) {
    return this.buildTree(this.root, "", maxDepth, 0);
  }
  buildTree(absDir, relDir, maxDepth, depth) {
    if (depth >= maxDepth) return [];
    if (!fs.existsSync(absDir)) return [];
    return fs.readdirSync(absDir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".") && !HIDDEN_DIRS.has(entry.name)).map((entry) => {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(absDir, entry.name);
      const stat = fs.statSync(absPath);
      const node = {
        name: entry.name,
        path: relPath,
        is_dir: entry.isDirectory(),
        size: stat.size,
        modified: stat.mtime.toISOString(),
        extension: entry.isDirectory() ? "" : path.extname(entry.name).toLowerCase()
      };
      if (entry.isDirectory()) {
        node.children = this.buildTree(absPath, relPath, maxDepth, depth + 1);
      }
      return node;
    }).sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
  }
  // ─── Metadata ───
  getFileMetadata(relativePath, linkIndex) {
    const absPath = this.resolveSafePath(relativePath);
    const stat = fs.statSync(absPath);
    const content = fs.readFileSync(absPath, "utf-8");
    const words = content.match(/[\p{L}\p{N}]+/gu) || [];
    const tags = this.extractTags(content);
    const backlinkCount = linkIndex ? linkIndex.getBacklinks(relativePath).length : 0;
    return {
      path: relativePath,
      size: stat.size,
      modified: stat.mtime.toISOString(),
      word_count: words.length,
      char_count: content.length,
      tags,
      backlink_count: backlinkCount
    };
  }
  extractTags(content) {
    const tagSet = /* @__PURE__ */ new Set();
    const lines = content.split("\n");
    let inCodeBlock = false;
    for (const line of lines) {
      if (line.trimStart().startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;
      const matches = line.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu);
      for (const match of matches) {
        tagSet.add(match[1]);
      }
    }
    return Array.from(tagSet).sort();
  }
  // ─── Config Persistence ───
  readConfig(filename, defaultValue) {
    const filePath = path.join(this.configDir, filename);
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch {
    }
    return defaultValue;
  }
  writeConfig(filename, data) {
    const filePath = path.join(this.configDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
  // ─── Plugin Support ───
  listPlugins() {
    const pluginDir = path.join(this.configDir, "plugins");
    if (!fs.existsSync(pluginDir)) return [];
    const enabledList = this.readConfig("plugins.json", { enabled: [] });
    const plugins = [];
    for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(pluginDir, entry.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
        const hasStyles = fs.existsSync(path.join(pluginDir, entry.name, "styles.css"));
        plugins.push({
          manifest,
          enabled: enabledList.enabled.includes(manifest.id),
          has_styles: hasStyles,
          dir: path.join(pluginDir, entry.name)
        });
      } catch {
      }
    }
    return plugins;
  }
  async togglePlugin(pluginId, enabled) {
    const config = this.readConfig("plugins.json", { enabled: [] });
    if (enabled && !config.enabled.includes(pluginId)) {
      config.enabled.push(pluginId);
    } else if (!enabled) {
      config.enabled = config.enabled.filter((id) => id !== pluginId);
    }
    this.writeConfig("plugins.json", config);
  }
  async deletePlugin(pluginId) {
    const pluginDir = path.join(this.configDir, "plugins", pluginId);
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
    }
    const config = this.readConfig("plugins.json", { enabled: [] });
    config.enabled = config.enabled.filter((id) => id !== pluginId);
    this.writeConfig("plugins.json", config);
  }
  readPluginFile(pluginId, filename) {
    const filePath = path.join(this.configDir, "plugins", pluginId, filename);
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf-8");
  }
  // ─── Self-write tracking ───
  isSelfWrite(relativePath) {
    return this.selfWrites.has(relativePath);
  }
  // ─── Walk all markdown files ───
  *walkMarkdownFiles() {
    yield* this.walkDir(this.root, "");
  }
  *walkDir(absDir, relDir) {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || HIDDEN_DIRS.has(entry.name)) continue;
      const absPath = path.join(absDir, entry.name);
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        yield* this.walkDir(absPath, relPath);
      } else if (entry.name.endsWith(".md")) {
        try {
          const content = fs.readFileSync(absPath, "utf-8");
          yield { relativePath: relPath, content };
        } catch {
        }
      }
    }
  }
}
class LinkIndex {
  constructor() {
    __publicField(this, "forward", /* @__PURE__ */ new Map());
    // source → outgoing links
    __publicField(this, "backward", /* @__PURE__ */ new Map());
    // target → incoming links
    __publicField(this, "knownFiles", /* @__PURE__ */ new Set());
  }
  registerFile(relativePath) {
    this.knownFiles.add(this.normalizePath(relativePath));
  }
  removeFile(relativePath) {
    const normalized = this.normalizePath(relativePath);
    this.knownFiles.delete(normalized);
    const outgoing = this.forward.get(normalized) || [];
    for (const link of outgoing) {
      const backlinks = this.backward.get(link.target) || [];
      this.backward.set(link.target, backlinks.filter((l) => l.source !== normalized));
    }
    this.forward.delete(normalized);
    const incoming = this.backward.get(normalized) || [];
    for (const link of incoming) {
      const fwd = this.forward.get(link.source) || [];
      this.forward.set(link.source, fwd.filter((l) => l.target !== normalized));
    }
    this.backward.delete(normalized);
  }
  updateFileLinks(relativePath, content, vaultRoot) {
    const normalized = this.normalizePath(relativePath);
    const oldOutgoing = this.forward.get(normalized) || [];
    for (const link of oldOutgoing) {
      const backlinks = this.backward.get(link.target) || [];
      this.backward.set(link.target, backlinks.filter((l) => l.source !== normalized));
    }
    const links = this.parseLinks(content, normalized, vaultRoot);
    this.forward.set(normalized, links);
    for (const link of links) {
      const backlinks = this.backward.get(link.target) || [];
      backlinks.push(link);
      this.backward.set(link.target, backlinks);
    }
  }
  getForwardLinks(relativePath) {
    return this.forward.get(this.normalizePath(relativePath)) || [];
  }
  getBacklinks(relativePath) {
    return this.backward.get(this.normalizePath(relativePath)) || [];
  }
  backlinkCount(relativePath) {
    return (this.backward.get(this.normalizePath(relativePath)) || []).length;
  }
  buildGraph() {
    const nodes = [];
    const nodeSet = /* @__PURE__ */ new Set();
    const edges = [];
    for (const filePath of this.knownFiles) {
      if (!nodeSet.has(filePath)) {
        nodeSet.add(filePath);
        nodes.push({
          id: filePath,
          label: path.basename(filePath, path.extname(filePath)),
          path: filePath,
          backlink_count: this.backlinkCount(filePath)
        });
      }
    }
    for (const [source, links] of this.forward) {
      for (const link of links) {
        if (!nodeSet.has(link.target)) {
          nodeSet.add(link.target);
          nodes.push({
            id: link.target,
            label: path.basename(link.target, path.extname(link.target)),
            path: link.target,
            backlink_count: this.backlinkCount(link.target)
          });
        }
        edges.push({
          source,
          target: link.target,
          link_type: link.link_type
        });
      }
    }
    return { nodes, edges };
  }
  getUnresolvedLinks() {
    const unresolved = [];
    for (const links of this.forward.values()) {
      for (const link of links) {
        if (!this.knownFiles.has(link.target)) {
          unresolved.push(link);
        }
      }
    }
    return unresolved;
  }
  // ─── Link Parsing ───
  parseLinks(content, source, _vaultRoot) {
    const links = [];
    const lines = content.split("\n");
    let inCodeBlock = false;
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```")) {
        inCodeBlock = !inCodeBlock;
        continue;
      }
      if (inCodeBlock) continue;
      this.parseWikiLinks(line, lineNum, source, links);
      this.parseEmbeds(line, lineNum, source, links);
      this.parseMarkdownLinks(line, lineNum, source, links);
    }
    return links;
  }
  parseWikiLinks(line, lineNum, source, links) {
    var _a;
    const regex = new RegExp("(?<!!)\\[\\[([^\\]|]+?)(?:\\|([^\\]]+?))?\\]\\]", "g");
    let match;
    while ((match = regex.exec(line)) !== null) {
      const target = this.resolveLinkTarget(match[1].trim());
      const display = ((_a = match[2]) == null ? void 0 : _a.trim()) || match[1].trim();
      links.push({
        source,
        target,
        display_text: display,
        link_type: "wiki",
        line: lineNum,
        column: match.index
      });
    }
  }
  parseEmbeds(line, lineNum, source, links) {
    var _a;
    const regex = /!\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;
    let match;
    while ((match = regex.exec(line)) !== null) {
      const target = this.resolveLinkTarget(match[1].trim());
      const display = ((_a = match[2]) == null ? void 0 : _a.trim()) || match[1].trim();
      links.push({
        source,
        target,
        display_text: display,
        link_type: "embed",
        line: lineNum,
        column: match.index
      });
    }
  }
  parseMarkdownLinks(line, lineNum, source, links) {
    const regex = new RegExp("(?<!!)\\[([^\\]]*)\\]\\(([^)]+)\\)", "g");
    let match;
    while ((match = regex.exec(line)) !== null) {
      const url = match[2].trim();
      if (/^(https?|mailto|ftp):/.test(url)) continue;
      const target = this.resolveLinkTarget(url);
      links.push({
        source,
        target,
        display_text: match[1].trim(),
        link_type: "markdown",
        line: lineNum,
        column: match.index
      });
    }
  }
  resolveLinkTarget(raw) {
    let target = raw.split("#")[0].trim();
    if (!target) return raw;
    target = target.replace(/\\/g, "/");
    if (!path.extname(target)) {
      target = target + ".md";
    }
    return this.normalizePath(target);
  }
  normalizePath(p) {
    return p.replace(/\\/g, "/");
  }
}
class SearchIndex {
  constructor() {
    __publicField(this, "documents", /* @__PURE__ */ new Map());
  }
  indexDocument(path2, content) {
    this.documents.set(path2, content);
  }
  removeDocument(path2) {
    this.documents.delete(path2);
  }
  search(query) {
    const { text, limit, extension_filter, path_filter } = query;
    if (!text.trim()) return [];
    const searchTermLower = text.toLowerCase();
    const results = [];
    for (const [docPath, content] of this.documents) {
      if (extension_filter && !docPath.endsWith(extension_filter)) continue;
      if (path_filter && !docPath.startsWith(path_filter)) continue;
      const contentLower = content.toLowerCase();
      const matchIndex = contentLower.indexOf(searchTermLower);
      if (matchIndex === -1) continue;
      const snippets = this.extractSnippets(content, searchTermLower, 5);
      if (snippets.length === 0) continue;
      let matchCount = 0;
      let idx = 0;
      while ((idx = contentLower.indexOf(searchTermLower, idx)) !== -1) {
        matchCount++;
        idx += searchTermLower.length;
      }
      const filename = docPath.split("/").pop() || docPath;
      const titleBoost = filename.toLowerCase().includes(searchTermLower) ? 10 : 0;
      const score = matchCount + titleBoost - content.length / 1e5;
      results.push({
        path: docPath,
        filename,
        snippets,
        score
      });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
  extractSnippets(content, searchTermLower, maxSnippets) {
    const snippets = [];
    const lines = content.split("\n");
    const termLen = searchTermLower.length;
    for (let i = 0; i < lines.length && snippets.length < maxSnippets; i++) {
      const line = lines[i];
      const lineLower = line.toLowerCase();
      const matchIdx = lineLower.indexOf(searchTermLower);
      if (matchIdx === -1) continue;
      snippets.push({
        text: line,
        line: i + 1,
        highlight_start: matchIdx,
        highlight_end: matchIdx + termLen
      });
    }
    return snippets;
  }
  get documentCount() {
    return this.documents.size;
  }
}
const DEBOUNCE_MS = 300;
const IGNORED_PATTERNS = [
  "**/.mindzj/**",
  "**/.git/**",
  "**/.obsidian/**",
  "**/node_modules/**",
  "**/*.tmp",
  "**/*~"
];
class VaultWatcher {
  constructor(vault, mainWindow) {
    __publicField(this, "watcher", null);
    __publicField(this, "debounceTimers", /* @__PURE__ */ new Map());
    __publicField(this, "vault");
    __publicField(this, "mainWindow");
    this.vault = vault;
    this.mainWindow = mainWindow;
  }
  start() {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.vault.root, {
      ignored: IGNORED_PATTERNS,
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 100
      }
    });
    this.watcher.on("add", (absPath) => this.debounceEvent(absPath, "created")).on("change", (absPath) => this.debounceEvent(absPath, "modified")).on("unlink", (absPath) => this.debounceEvent(absPath, "deleted"));
  }
  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
  setWindow(win) {
    this.mainWindow = win;
  }
  debounceEvent(absPath, type) {
    const relativePath = path.relative(this.vault.root, absPath).replace(/\\/g, "/");
    if (this.vault.isSelfWrite(relativePath)) return;
    const key = `${type}:${relativePath}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      this.emitEvent({ type, path: relativePath });
    }, DEBOUNCE_MS);
    this.debounceTimers.set(key, timer);
  }
  emitEvent(event) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send("file-changed", event);
    }
  }
}
const DEFAULT_SETTINGS = {
  theme: "dark",
  font_size: 16,
  font_family: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  editor_line_numbers: false,
  editor_word_wrap: true,
  editor_vim_mode: false,
  editor_spell_check: false,
  editor_readable_line_length: true,
  auto_save_interval_ms: 2e3,
  default_view_mode: "live-preview",
  locale: "zh-CN",
  accent_color: null,
  css_snippet: null,
  attachment_folder: "attachments",
  auto_update_links: true,
  default_new_note_location: "vault-root",
  template_folder: null
};
const DEFAULT_WORKSPACE = {
  open_files: [],
  active_file: null,
  sidebar_tab: "files",
  sidebar_collapsed: false,
  sidebar_width: 260
};
const _AppState = class _AppState {
  constructor() {
    __publicField(this, "currentVault", null);
    __publicField(this, "recentVaults", []);
  }
  static getInstance() {
    if (!_AppState.instance) {
      _AppState.instance = new _AppState();
    }
    return _AppState.instance;
  }
  currentContext() {
    return this.currentVault;
  }
  getVaultInfo() {
    var _a;
    return ((_a = this.currentVault) == null ? void 0 : _a.info) ?? null;
  }
  async openVault(vaultPath, name) {
    if (this.currentVault) {
      this.currentVault.watcher.stop();
    }
    const vault = new Vault(vaultPath);
    const linkIndex = new LinkIndex();
    const searchIndex = new SearchIndex();
    const mainWindow = electron.BrowserWindow.getFocusedWindow();
    const watcher = new VaultWatcher(vault, mainWindow);
    const info = {
      name: name || path.basename(vaultPath),
      path: vaultPath,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      last_opened: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.currentVault = { vault, info, linkIndex, searchIndex, watcher };
    this.buildIndexes();
    watcher.start();
    this.updateRecentVaults(info);
    return info;
  }
  closeCurrentVault() {
    if (this.currentVault) {
      this.currentVault.watcher.stop();
      this.currentVault = null;
    }
  }
  buildIndexes() {
    if (!this.currentVault) return;
    const { vault, linkIndex, searchIndex } = this.currentVault;
    for (const { relativePath, content } of vault.walkMarkdownFiles()) {
      linkIndex.registerFile(relativePath);
      linkIndex.updateFileLinks(relativePath, content, vault.root);
      searchIndex.indexDocument(relativePath, content);
    }
  }
  updateRecentVaults(info) {
    this.recentVaults = this.recentVaults.filter((v) => v.path !== info.path);
    this.recentVaults.unshift(info);
    if (this.recentVaults.length > 20) {
      this.recentVaults = this.recentVaults.slice(0, 20);
    }
  }
  // ─── Settings ───
  getSettings() {
    if (!this.currentVault) {
      return { ...DEFAULT_SETTINGS };
    }
    const saved = this.currentVault.vault.readConfig("settings.json", {});
    return { ...DEFAULT_SETTINGS, ...saved };
  }
  async updateSettings(partial) {
    if (!this.currentVault) return;
    const current = this.getSettings();
    const merged = { ...current, ...partial };
    this.currentVault.vault.writeConfig("settings.json", merged);
  }
  // ─── Workspace ───
  loadWorkspace() {
    if (!this.currentVault) {
      return { ...DEFAULT_WORKSPACE };
    }
    return this.currentVault.vault.readConfig("workspace.json", { ...DEFAULT_WORKSPACE });
  }
  async saveWorkspace(state) {
    if (!this.currentVault) return;
    this.currentVault.vault.writeConfig("workspace.json", state);
  }
  // ─── Hotkeys ───
  getHotkeys() {
    if (!this.currentVault) return [];
    return this.currentVault.vault.readConfig("hotkeys.json", []);
  }
  async saveHotkeys(bindings) {
    if (!this.currentVault) return;
    this.currentVault.vault.writeConfig("hotkeys.json", bindings);
  }
};
__publicField(_AppState, "instance");
let AppState = _AppState;
const appState$3 = AppState.getInstance();
function registerVaultHandlers(ipcMain) {
  ipcMain.handle("vault:open", async (_event, vaultPath, name) => {
    return appState$3.openVault(vaultPath, name);
  });
  ipcMain.handle("vault:close", async () => {
    return appState$3.closeCurrentVault();
  });
  ipcMain.handle("vault:getInfo", async () => {
    return appState$3.getVaultInfo();
  });
  ipcMain.handle("vault:getFileTree", async (_event, maxDepth) => {
    const ctx = appState$3.currentContext();
    if (!ctx) return [];
    return ctx.vault.getFileTree(maxDepth ?? 10);
  });
  ipcMain.handle("vault:listEntries", async (_event, dir) => {
    const ctx = appState$3.currentContext();
    if (!ctx) return [];
    return ctx.vault.listEntries(dir);
  });
  ipcMain.handle("vault:readFile", async (_event, relativePath) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    return ctx.vault.readFile(relativePath);
  });
  ipcMain.handle("vault:writeFile", async (_event, relativePath, content) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    const result = await ctx.vault.writeFile(relativePath, content);
    ctx.linkIndex.updateFileLinks(relativePath, content, ctx.vault.root);
    ctx.searchIndex.indexDocument(relativePath, content);
    return result;
  });
  ipcMain.handle("vault:createFile", async (_event, relativePath, content) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    const result = await ctx.vault.createFile(relativePath, content);
    ctx.linkIndex.registerFile(relativePath);
    ctx.linkIndex.updateFileLinks(relativePath, content, ctx.vault.root);
    ctx.searchIndex.indexDocument(relativePath, content);
    return result;
  });
  ipcMain.handle("vault:deleteFile", async (_event, relativePath) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    await ctx.vault.deleteFile(relativePath);
    ctx.linkIndex.removeFile(relativePath);
    ctx.searchIndex.removeDocument(relativePath);
    return true;
  });
  ipcMain.handle("vault:renameFile", async (_event, from, to) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    await ctx.vault.renameFile(from, to);
    ctx.linkIndex.removeFile(from);
    ctx.linkIndex.registerFile(to);
    try {
      const content = await ctx.vault.readFile(to);
      ctx.linkIndex.updateFileLinks(to, content.content, ctx.vault.root);
      ctx.searchIndex.removeDocument(from);
      ctx.searchIndex.indexDocument(to, content.content);
    } catch {
    }
    return true;
  });
  ipcMain.handle("vault:createDir", async (_event, relativePath) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    await ctx.vault.createDir(relativePath);
    return true;
  });
  ipcMain.handle("vault:deleteDir", async (_event, relativePath, recursive) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    await ctx.vault.deleteDir(relativePath, recursive);
    return true;
  });
  ipcMain.handle("vault:getFileMetadata", async (_event, relativePath) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    return ctx.vault.getFileMetadata(relativePath, ctx.linkIndex);
  });
  ipcMain.handle("vault:listSnapshots", async (_event, relativePath) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    return ctx.vault.listSnapshots(relativePath);
  });
  ipcMain.handle("vault:restoreSnapshot", async (_event, relativePath, snapshotName) => {
    const ctx = appState$3.currentContext();
    if (!ctx) throw new Error("No vault open");
    return ctx.vault.restoreSnapshot(relativePath, snapshotName);
  });
}
const appState$2 = AppState.getInstance();
function registerSearchHandlers(ipcMain) {
  ipcMain.handle("search:query", async (_event, query, limit) => {
    const ctx = appState$2.currentContext();
    if (!ctx) return [];
    return ctx.searchIndex.search({
      text: query,
      limit: limit ?? 20
    });
  });
  ipcMain.handle("search:forwardLinks", async (_event, relativePath) => {
    const ctx = appState$2.currentContext();
    if (!ctx) return [];
    return ctx.linkIndex.getForwardLinks(relativePath);
  });
  ipcMain.handle("search:backlinks", async (_event, relativePath) => {
    const ctx = appState$2.currentContext();
    if (!ctx) return [];
    return ctx.linkIndex.getBacklinks(relativePath);
  });
  ipcMain.handle("search:graphData", async () => {
    const ctx = appState$2.currentContext();
    if (!ctx) return { nodes: [], edges: [] };
    return ctx.linkIndex.buildGraph();
  });
  ipcMain.handle("search:unresolvedLinks", async () => {
    const ctx = appState$2.currentContext();
    if (!ctx) return [];
    return ctx.linkIndex.getUnresolvedLinks();
  });
}
const appState$1 = AppState.getInstance();
function registerSettingsHandlers(ipcMain) {
  ipcMain.handle("settings:get", async () => {
    return appState$1.getSettings();
  });
  ipcMain.handle("settings:update", async (_event, settings) => {
    await appState$1.updateSettings(settings);
    return appState$1.getSettings();
  });
  ipcMain.handle("settings:getHotkeys", async () => {
    return appState$1.getHotkeys();
  });
  ipcMain.handle("settings:saveHotkeys", async (_event, bindings) => {
    await appState$1.saveHotkeys(bindings);
    return true;
  });
  ipcMain.handle("workspace:load", async () => {
    return appState$1.loadWorkspace();
  });
  ipcMain.handle("workspace:save", async (_event, state) => {
    await appState$1.saveWorkspace(state);
    return true;
  });
}
const appState = AppState.getInstance();
function registerPluginHandlers(ipcMain) {
  ipcMain.handle("plugin:list", async () => {
    const ctx = appState.currentContext();
    if (!ctx) return [];
    return ctx.vault.listPlugins();
  });
  ipcMain.handle("plugin:toggle", async (_event, pluginId, enabled) => {
    const ctx = appState.currentContext();
    if (!ctx) return false;
    await ctx.vault.togglePlugin(pluginId, enabled);
    return true;
  });
  ipcMain.handle("plugin:delete", async (_event, pluginId) => {
    const ctx = appState.currentContext();
    if (!ctx) return false;
    await ctx.vault.deletePlugin(pluginId);
    return true;
  });
  ipcMain.handle("plugin:readMain", async (_event, pluginId) => {
    const ctx = appState.currentContext();
    if (!ctx) return "";
    return ctx.vault.readPluginFile(pluginId, "main.js");
  });
  ipcMain.handle("plugin:readStyles", async (_event, pluginId) => {
    const ctx = appState.currentContext();
    if (!ctx) return "";
    return ctx.vault.readPluginFile(pluginId, "styles.css");
  });
}
function registerAllHandlers(ipcMain) {
  registerVaultHandlers(ipcMain);
  registerSearchHandlers(ipcMain);
  registerSettingsHandlers(ipcMain);
  registerPluginHandlers(ipcMain);
}
exports.mainWindow = null;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = !!VITE_DEV_SERVER_URL;
function createWindow() {
  const win = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "MindZJ",
    backgroundColor: "#1e1e2e",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // needed for better-sqlite3 via preload
      webSecurity: true,
      spellcheck: true
    }
  });
  win.once("ready-to-show", () => {
    win.show();
    if (isDev) {
      win.webContents.openDevTools();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:") || url.startsWith("http:")) {
      electron.shell.openExternal(url);
    }
    return { action: "deny" };
  });
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
  return win;
}
function createMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        {
          label: "打开库",
          accelerator: "CmdOrCtrl+O",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:open-vault");
          }
        },
        { type: "separator" },
        {
          label: "新建笔记",
          accelerator: "CmdOrCtrl+N",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:new-note");
          }
        },
        { type: "separator" },
        {
          label: "保存",
          accelerator: "CmdOrCtrl+S",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:save");
          }
        },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
        { type: "separator" },
        {
          label: "查找",
          accelerator: "CmdOrCtrl+F",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:find");
          }
        },
        {
          label: "替换",
          accelerator: "CmdOrCtrl+H",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:replace");
          }
        }
      ]
    },
    {
      label: "视图",
      submenu: [
        {
          label: "切换侧边栏",
          accelerator: "CmdOrCtrl+B",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:toggle-sidebar");
          }
        },
        {
          label: "命令面板",
          accelerator: "CmdOrCtrl+P",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:command-palette");
          }
        },
        {
          label: "图谱视图",
          accelerator: "CmdOrCtrl+G",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:graph-view");
          }
        },
        { type: "separator" },
        {
          label: "放大",
          accelerator: "CmdOrCtrl+Plus",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:zoom-in");
          }
        },
        {
          label: "缩小",
          accelerator: "CmdOrCtrl+-",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:zoom-out");
          }
        },
        {
          label: "重置缩放",
          accelerator: "CmdOrCtrl+0",
          click: () => {
            var _a;
            return (_a = exports.mainWindow) == null ? void 0 : _a.webContents.send("menu:zoom-reset");
          }
        },
        { type: "separator" },
        { role: "toggleDevTools", label: "开发者工具" },
        { role: "togglefullscreen", label: "全屏" }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "关于 MindZJ",
          click: () => {
            electron.dialog.showMessageBox({
              type: "info",
              title: "关于 MindZJ",
              message: "MindZJ v0.1.0",
              detail: "开源离线笔记软件\n\nElectron + TypeScript + CodeMirror 6"
            });
          }
        }
      ]
    }
  ];
  const menu = electron.Menu.buildFromTemplate(template);
  electron.Menu.setApplicationMenu(menu);
}
function registerProtocols() {
  electron.protocol.registerFileProtocol("vault-asset", (request, callback) => {
    const url = request.url.replace("vault-asset://", "");
    const filePath = decodeURIComponent(url);
    callback({ path: filePath });
  });
}
electron.app.whenReady().then(() => {
  registerProtocols();
  registerAllHandlers(electron.ipcMain);
  createMenu();
  exports.mainWindow = createWindow();
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) {
      exports.mainWindow = createWindow();
    }
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.ipcMain.handle("app:newWindow", async (_event, vaultPath) => {
  const win = createWindow();
  win.webContents.once("did-finish-load", () => {
    win.webContents.send("open-vault", vaultPath);
  });
  return true;
});
electron.ipcMain.handle("dialog:openDirectory", async () => {
  const result = await electron.dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "选择库文件夹"
  });
  return result.canceled ? null : result.filePaths[0];
});
electron.ipcMain.handle("dialog:openFile", async (_event, filters) => {
  const result = await electron.dialog.showOpenDialog({
    properties: ["openFile"],
    filters: filters || [{ name: "All Files", extensions: ["*"] }]
  });
  return result.canceled ? null : result.filePaths[0];
});
electron.ipcMain.handle("dialog:saveFile", async (_event, defaultPath) => {
  const result = await electron.dialog.showSaveDialog({
    defaultPath,
    filters: [
      { name: "Markdown", extensions: ["md"] },
      { name: "All Files", extensions: ["*"] }
    ]
  });
  return result.canceled ? null : result.filePath;
});
electron.ipcMain.handle("shell:openPath", async (_event, filePath) => {
  return electron.shell.openPath(filePath);
});
electron.ipcMain.handle("shell:showItemInFolder", async (_event, filePath) => {
  electron.shell.showItemInFolder(filePath);
  return true;
});

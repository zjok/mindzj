"use strict";
const electron = require("electron");
const api = {
  // ─── Vault Operations ───
  openVault: (vaultPath, name) => electron.ipcRenderer.invoke("vault:open", vaultPath, name),
  closeVault: () => electron.ipcRenderer.invoke("vault:close"),
  getVaultInfo: () => electron.ipcRenderer.invoke("vault:getInfo"),
  getFileTree: (maxDepth) => electron.ipcRenderer.invoke("vault:getFileTree", maxDepth),
  listEntries: (dir) => electron.ipcRenderer.invoke("vault:listEntries", dir),
  readFile: (relativePath) => electron.ipcRenderer.invoke("vault:readFile", relativePath),
  writeFile: (relativePath, content) => electron.ipcRenderer.invoke("vault:writeFile", relativePath, content),
  createFile: (relativePath, content) => electron.ipcRenderer.invoke("vault:createFile", relativePath, content),
  deleteFile: (relativePath) => electron.ipcRenderer.invoke("vault:deleteFile", relativePath),
  renameFile: (from, to) => electron.ipcRenderer.invoke("vault:renameFile", from, to),
  createDir: (relativePath) => electron.ipcRenderer.invoke("vault:createDir", relativePath),
  deleteDir: (relativePath, recursive) => electron.ipcRenderer.invoke("vault:deleteDir", relativePath, recursive),
  getFileMetadata: (relativePath) => electron.ipcRenderer.invoke("vault:getFileMetadata", relativePath),
  listSnapshots: (relativePath) => electron.ipcRenderer.invoke("vault:listSnapshots", relativePath),
  restoreSnapshot: (relativePath, snapshotName) => electron.ipcRenderer.invoke("vault:restoreSnapshot", relativePath, snapshotName),
  // ─── Search & Links ───
  searchVault: (query, limit) => electron.ipcRenderer.invoke("search:query", query, limit),
  getForwardLinks: (relativePath) => electron.ipcRenderer.invoke("search:forwardLinks", relativePath),
  getBacklinks: (relativePath) => electron.ipcRenderer.invoke("search:backlinks", relativePath),
  getGraphData: () => electron.ipcRenderer.invoke("search:graphData"),
  getUnresolvedLinks: () => electron.ipcRenderer.invoke("search:unresolvedLinks"),
  // ─── Settings ───
  getSettings: () => electron.ipcRenderer.invoke("settings:get"),
  updateSettings: (settings) => electron.ipcRenderer.invoke("settings:update", settings),
  getHotkeys: () => electron.ipcRenderer.invoke("settings:getHotkeys"),
  saveHotkeys: (bindings) => electron.ipcRenderer.invoke("settings:saveHotkeys", bindings),
  // ─── Workspace ───
  loadWorkspace: () => electron.ipcRenderer.invoke("workspace:load"),
  saveWorkspace: (state) => electron.ipcRenderer.invoke("workspace:save", state),
  // ─── Plugins ───
  listPlugins: () => electron.ipcRenderer.invoke("plugin:list"),
  togglePlugin: (pluginId, enabled) => electron.ipcRenderer.invoke("plugin:toggle", pluginId, enabled),
  deletePlugin: (pluginId) => electron.ipcRenderer.invoke("plugin:delete", pluginId),
  readPluginMain: (pluginId) => electron.ipcRenderer.invoke("plugin:readMain", pluginId),
  readPluginStyles: (pluginId) => electron.ipcRenderer.invoke("plugin:readStyles", pluginId),
  // ─── Dialogs & Shell ───
  openDirectoryDialog: () => electron.ipcRenderer.invoke("dialog:openDirectory"),
  openFileDialog: (filters) => electron.ipcRenderer.invoke("dialog:openFile", filters),
  saveFileDialog: (defaultPath) => electron.ipcRenderer.invoke("dialog:saveFile", defaultPath),
  showItemInFolder: (path) => electron.ipcRenderer.invoke("shell:showItemInFolder", path),
  openPath: (path) => electron.ipcRenderer.invoke("shell:openPath", path),
  // ─── Window ───
  newWindow: (vaultPath) => electron.ipcRenderer.invoke("app:newWindow", vaultPath),
  // ─── Events (Main → Renderer) ───
  onFileChanged: (callback) => {
    const listener = (_, data) => callback(data);
    electron.ipcRenderer.on("file-changed", listener);
    return () => {
      electron.ipcRenderer.removeListener("file-changed", listener);
    };
  },
  onMenuAction: (action, callback) => {
    const channel = `menu:${action}`;
    const listener = () => callback();
    electron.ipcRenderer.on(channel, listener);
    return () => {
      electron.ipcRenderer.removeListener(channel, listener);
    };
  },
  onOpenVault: (callback) => {
    const listener = (_, path) => callback(path);
    electron.ipcRenderer.on("open-vault", listener);
    return () => {
      electron.ipcRenderer.removeListener("open-vault", listener);
    };
  }
};
electron.contextBridge.exposeInMainWorld("api", api);

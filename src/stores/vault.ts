import { createSignal, createRoot } from "solid-js";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types mirroring Rust kernel types
// ---------------------------------------------------------------------------

export interface VaultInfo {
  name: string;
  path: string;
  created_at: string;
  last_opened: string;
}

export interface VaultEntry {
  name: string;
  relative_path: string;
  is_dir: boolean;
  size: number;
  modified: string;
  extension: string;
  children?: VaultEntry[];
}

export interface FileContent {
  path: string;
  content: string;
  modified: string;
  hash: string;
  kind?: "text" | "image" | "document";
}

export interface FileMetadata {
  relative_path: string;
  size: number;
  created: string;
  modified: string;
  is_markdown: boolean;
  word_count: number;
  char_count: number;
  tags: string[];
  backlink_count: number;
}

// ---------------------------------------------------------------------------
// Vault store
// ---------------------------------------------------------------------------

function createVaultStore() {
  const [vaultInfo, setVaultInfo] = createSignal<VaultInfo | null>(null);
  const [fileTree, setFileTree] = createSignal<VaultEntry[]>([]);
  const [activeFile, setActiveFile] = createSignal<FileContent | null>(null);
  const [openFiles, setOpenFiles] = createSignal<FileContent[]>([]);
  const [isLoading, setIsLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  function upsertOpenFile(content: FileContent) {
    setOpenFiles((prev) => {
      const exists = prev.some((f) => f.path === content.path);
      if (exists) {
        return prev.map((f) => (f.path === content.path ? content : f));
      }
      return [...prev, content];
    });
  }

  // Open a vault
  async function openVault(path: string, name: string): Promise<void> {
    setIsLoading(true);
    setError(null);
    try {
      const info = await invoke<VaultInfo>("open_vault", { path, name });
      setVaultInfo(info);
      await refreshFileTree();
    } catch (e: any) {
      setError(e.message || "Failed to open vault");
      throw e;
    } finally {
      setIsLoading(false);
    }
  }

  // Refresh the file tree
  async function refreshFileTree(): Promise<void> {
    try {
      const tree = await invoke<VaultEntry[]>("get_file_tree", {
        maxDepth: 10,
      });
      setFileTree(tree);
    } catch (e: any) {
      setError(e.message || "Failed to load file tree");
    }
  }

  // Open a file for editing (user action — sets it as active)
  async function openFile(relativePath: string): Promise<FileContent> {
    setIsLoading(true);
    try {
      const raw = await invoke<FileContent>("read_file", {
        relativePath,
      });
      const content: FileContent = { ...raw, kind: "text" };

      setActiveFile(content);
      upsertOpenFile(content);

      return content;
    } catch (e: any) {
      setError(e.message || "Failed to open file");
      throw e;
    } finally {
      setIsLoading(false);
    }
  }

  // Reload a file that's already open without changing the active tab.
  // Used by the file-system watcher: when an OTHER tab's content is
  // modified on disk we want to refresh its buffer in `openFiles`, but
  // we MUST NOT yank the user off whatever tab they're currently on.
  async function reloadFile(relativePath: string): Promise<void> {
    try {
      const existing = openFiles().find((file) => file.path === relativePath);
      if (existing?.kind && existing.kind !== "text") return;

      const raw = await invoke<FileContent>("read_file", { relativePath });
      const content: FileContent = { ...raw, kind: "text" };
      setOpenFiles((prev) =>
        prev.some((f) => f.path === content.path)
          ? prev.map((f) => (f.path === content.path ? content : f))
          : prev,
      );
      // Only update the active-file signal if this IS the active file —
      // that way its hash/modified timestamp stay in sync for dirty
      // checking, but the focus never moves.
      if (activeFile()?.path === content.path) {
        setActiveFile(content);
      }
    } catch (e: any) {
      console.warn("reloadFile failed:", e);
    }
  }

  // Save file content (atomic write via kernel)
  // CRITICAL: saveFile must NOT change `activeFile` unless the file we just
  // saved is still the active one. The auto-save timer is per-file, so it
  // can easily fire while the user has already switched to another tab —
  // overwriting activeFile in that case yanks the user back to the tab
  // that was saved (the "auto-save steals focus" bug).
  async function saveFile(
    relativePath: string,
    content: string
  ): Promise<FileContent> {
    try {
      const raw = await invoke<FileContent>("write_file", {
        relativePath,
        content,
      });
      const result: FileContent = { ...raw, kind: "text" };

      // Only promote the saved file to active if it already was — this
      // keeps the modified timestamp / hash in sync without clobbering
      // the user's current tab.
      if (activeFile()?.path === result.path) {
        setActiveFile(result);
      }
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === result.path ? result : f))
      );

      // Notify listeners (global search panel, etc.) that a file
      // was just persisted. The Rust backend has already re-indexed
      // this path in `on_file_changed`, so a follow-up `search_vault`
      // call will return fresh results.
      try {
        document.dispatchEvent(
          new CustomEvent("mindzj:vault-file-saved", {
            detail: { path: result.path },
          }),
        );
      } catch {
        // Non-fatal: save itself succeeded; the event is just a hint.
      }

      return result;
    } catch (e: any) {
      setError(e.message || "Failed to save file");
      throw e;
    }
  }

  // Create a new file
  async function createFile(
    relativePath: string,
    content: string = ""
  ): Promise<FileContent> {
    try {
      const raw = await invoke<FileContent>("create_file", {
        relativePath,
        content,
      });
      const result: FileContent = { ...raw, kind: "text" };
      await refreshFileTree();
      return result;
    } catch (e: any) {
      setError(e.message || "Failed to create file");
      throw e;
    }
  }

  function matchesDeletedPath(candidate: string, relativePath: string, recursive: boolean) {
    return recursive
      ? candidate === relativePath || candidate.startsWith(`${relativePath}/`)
      : candidate === relativePath;
  }

  async function removeOpenEntry(relativePath: string, recursive: boolean) {
    const remaining = openFiles().filter(
      (file) => !matchesDeletedPath(file.path, relativePath, recursive),
    );
    setOpenFiles(remaining);

    const active = activeFile();
    if (active && matchesDeletedPath(active.path, relativePath, recursive)) {
      setActiveFile(remaining.length > 0 ? remaining[remaining.length - 1] : null);
    }
  }

  // Delete a file
  async function deleteFile(relativePath: string): Promise<void> {
    try {
      await invoke("delete_file", { relativePath });
      await removeOpenEntry(relativePath, false);
      await refreshFileTree();
    } catch (e: any) {
      setError(e.message || "Failed to delete file");
      throw e;
    }
  }

  async function deleteDir(relativePath: string): Promise<void> {
    try {
      await invoke("delete_dir", { relativePath, recursive: true });
      await removeOpenEntry(relativePath, true);
      await refreshFileTree();
    } catch (e: any) {
      setError(e.message || "Failed to delete directory");
      throw e;
    }
  }

  // Create a directory
  async function createDir(relativePath: string): Promise<void> {
    try {
      await invoke("create_dir", { relativePath });
      await refreshFileTree();
    } catch (e: any) {
      setError(e.message || "Failed to create directory");
      throw e;
    }
  }

  // Close a tab (file)
  function closeFile(relativePath: string) {
    setOpenFiles((prev) => prev.filter((f) => f.path !== relativePath));
    if (activeFile()?.path === relativePath) {
      const remaining = openFiles().filter(
        (f) => f.path !== relativePath
      );
      setActiveFile(
        remaining.length > 0 ? remaining[remaining.length - 1] : null
      );
    }
  }

  // Switch to a different open file tab
  function switchToFile(relativePath: string) {
    const file = openFiles().find((f) => f.path === relativePath);
    if (file) {
      setActiveFile(file);
    }
  }

  function openPreviewFile(
    relativePath: string,
    kind: Extract<FileContent["kind"], "image" | "document">,
  ): FileContent {
    const preview: FileContent = {
      path: relativePath,
      content: "",
      modified: "",
      hash: "",
      kind,
    };
    setActiveFile(preview);
    upsertOpenFile(preview);
    return preview;
  }

  // Close the current vault and reset all state
  function closeVault() {
    setVaultInfo(null);
    setFileTree([]);
    setActiveFile(null);
    setOpenFiles([]);
    setError(null);
    setIsLoading(false);
  }

  // Update file paths after a rename (keeps open tabs & active file in sync)
  function renameFilePath(oldPath: string, newPath: string) {
    const active = activeFile();
    if (active && active.path === oldPath) {
      setActiveFile({ ...active, path: newPath });
    }
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === oldPath ? { ...f, path: newPath } : f)),
    );
  }

  // Reorder open tabs
  function reorderOpenFiles(fromIdx: number, toIdx: number) {
    setOpenFiles(prev => {
      const files = [...prev];
      const [moved] = files.splice(fromIdx, 1);
      files.splice(toIdx, 0, moved);
      return files;
    });
  }

  return {
    // State (readonly signals)
    vaultInfo,
    fileTree,
    activeFile,
    openFiles,
    isLoading,
    error,
    // Actions
    openVault,
    refreshFileTree,
    openFile,
    openPreviewFile,
    reloadFile,
    saveFile,
    createFile,
    deleteFile,
    deleteDir,
    createDir,
    closeFile,
    closeVault,
    switchToFile,
    setActiveFile,
    renameFilePath,
    reorderOpenFiles,
  };
}

// Singleton store instance
export const vaultStore = createRoot(createVaultStore);

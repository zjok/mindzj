import { createSignal, createRoot } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { ViewMode } from "./editor";

type FileScrollPositionMap = Record<string, Partial<Record<ViewMode, number>>>;
type EditableViewMode = Exclude<ViewMode, "reading">;
type PaneSlot = "primary" | "secondary";
type SplitDirection = "left" | "right" | "up" | "down";

export interface WorkspaceState {
  open_files: string[];
  active_file: string | null;
  primary_pane_path?: string | null;
  secondary_pane_path?: string | null;
  active_pane_slot?: PaneSlot;
  split_direction?: SplitDirection;
  split_ratio?: number;
  sidebar_tab: string;
  sidebar_collapsed: boolean;
  sidebar_width: number;
  sidebar_tab_order?: string[];
  file_scroll_positions?: FileScrollPositionMap;
  file_top_lines?: Record<string, number>;
  file_view_modes?: Record<string, ViewMode>;
  file_last_non_reading_view_modes?: Record<string, EditableViewMode>;
  // Window geometry
  window_x?: number | null;
  window_y?: number | null;
  window_width?: number | null;
  window_height?: number | null;
  window_maximized?: boolean | null;
}

const DEFAULT_WORKSPACE: WorkspaceState = {
  open_files: [],
  active_file: null,
  primary_pane_path: null,
  secondary_pane_path: null,
  active_pane_slot: "primary",
  split_direction: "right",
  split_ratio: 0.5,
  sidebar_tab: "files",
  sidebar_collapsed: false,
  sidebar_width: 260,
  sidebar_tab_order: [],
  file_scroll_positions: {},
  file_top_lines: {},
  file_view_modes: {},
  file_last_non_reading_view_modes: {},
};

function createWorkspaceStore() {
  const [workspace, setWorkspace] = createSignal<WorkspaceState>({ ...DEFAULT_WORKSPACE });
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadWorkspace(): Promise<WorkspaceState> {
    try {
      const ws = await invoke<WorkspaceState>("load_workspace");
      setWorkspace(ws);
      return ws;
    } catch (e) {
      console.warn("Failed to load workspace:", e);
      return DEFAULT_WORKSPACE;
    }
  }

  async function saveWorkspace(ws?: Partial<WorkspaceState>) {
    if (ws) {
      setWorkspace((prev) => ({ ...prev, ...ws }));
    }
    try {
      await invoke("save_workspace", { workspace: workspace() });
    } catch (e) {
      console.error("Failed to save workspace:", e);
    }
  }

  // Debounced save (1 second after last change)
  function scheduleSave(partial?: Partial<WorkspaceState>) {
    if (partial) {
      setWorkspace((prev) => ({ ...prev, ...partial }));
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWorkspace(), 1000);
  }

  return {
    workspace,
    loadWorkspace,
    saveWorkspace,
    scheduleSave,
  };
}

export const workspaceStore = createRoot(createWorkspaceStore);

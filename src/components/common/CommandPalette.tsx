import {
  Component,
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { vaultStore } from "../../stores/vault";
import { editorStore } from "../../stores/editor";
import { settingsStore } from "../../stores/settings";
import { listPluginCommands, runPluginCommand } from "../../stores/plugins";
import type { VaultEntry } from "../../stores/vault";
import { displayName } from "../../utils/displayName";
import { openFileRouted } from "../../utils/openFileRouted";
import { t } from "../../i18n";
import { promptDialog } from "./ConfirmDialog";

interface PaletteItem {
  id: string;
  label: string;
  category: "file" | "command" | "create";
  description?: string;
  shortcut?: string;
  action: () => void | Promise<void>;
}

const DEFAULT_COMMAND_HOTKEYS: Record<string, string> = {
  "ai-control": "Alt+`",
  "new-note": "Ctrl+N",
  "toggle-view-mode": "Ctrl+E",
  bold: "Ctrl+B",
  italic: "Ctrl+I",
  strikethrough: "Ctrl+Shift+S",
  underline: "Ctrl+U",
  highlight: "Ctrl+Shift+H",
  link: "Ctrl+K",
  code: "Ctrl+Shift+E",
  "heading-1": "Ctrl+1",
  "heading-2": "Ctrl+2",
  "heading-3": "Ctrl+3",
  "heading-4": "Ctrl+4",
  "heading-5": "Ctrl+5",
  "heading-6": "Ctrl+6",
  "move-line-up": "Alt+Up",
  "move-line-down": "Alt+Down",
  "toggle-comment": "Ctrl+/",
  "toggle-blockquote": "Ctrl+Shift+.",
  "toggle-sidebar": "Ctrl+`",
  "plugin:timestamp-header:insert-timestamp": "Alt+F",
  "plugin:timestamp-header:insert-separator": "Alt+A",
};

const PLUGIN_COMMAND_HOTKEY_ALIASES: Record<string, string> = {
  "editor:toggle-bold": "bold",
  "editor:toggle-italics": "italic",
  "editor:toggle-strikethrough": "strikethrough",
  "editor:toggle-underline": "underline",
  "editor:toggle-highlight": "highlight",
  "editor:toggle-code": "code",
  "editor:toggle-blockquote": "toggle-blockquote",
  "editor:toggle-comments": "toggle-comment",
  "editor:insert-link": "link",
  "editor:swap-line-up": "move-line-up",
  "editor:swap-line-down": "move-line-down",
  "editor:set-heading-1": "heading-1",
  "editor:set-heading-2": "heading-2",
  "editor:set-heading-3": "heading-3",
  "editor:set-heading-4": "heading-4",
  "editor:set-heading-5": "heading-5",
  "editor:set-heading-6": "heading-6",
  "app:toggle-left-sidebar": "toggle-sidebar",
};

function configuredHotkey(command: string): string {
  const overrides = settingsStore.settings().hotkey_overrides || {};
  return overrides[command] || DEFAULT_COMMAND_HOTKEYS[command] || "";
}

function formatPluginHotkey(hotkey?: { modifiers?: string[]; key?: string }): string {
  if (!hotkey?.key) return "";
  const parts = [
    ...(hotkey.modifiers ?? []).map((modifier) =>
      modifier.length === 1 ? modifier.toUpperCase() : modifier[0].toUpperCase() + modifier.slice(1),
    ),
    hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key,
  ];
  return parts.join("+");
}

function pluginCommandShortcut(commandId: string, hotkeys?: Array<{ modifiers?: string[]; key?: string }>): string {
  const direct = configuredHotkey(commandId);
  if (direct) return direct;
  const alias = PLUGIN_COMMAND_HOTKEY_ALIASES[commandId];
  if (alias) return configuredHotkey(alias);
  return formatPluginHotkey(hotkeys?.[0]);
}

/**
 * Two palette modes:
 *   - "commands": show built-in + plugin commands only. Bound to
 *     Ctrl+P. Placeholder reads "Select a command…".
 *   - "files":    show notes + a "Create new note" action when the
 *     query doesn't match an existing file. Bound to Ctrl+O.
 *     Placeholder reads "Find or create a note…".
 * The split mirrors Obsidian's Ctrl+P (command palette) and
 * Ctrl+O (quick switcher / find-or-create).
 */
export type CommandPaletteMode = "commands" | "files";

interface CommandPaletteProps {
  onClose: () => void;
  mode?: CommandPaletteMode;
}

function flattenEntries(
  entries: VaultEntry[],
  result: PaletteItem[] = [],
): PaletteItem[] {
  for (const entry of entries) {
    if (entry.is_dir) {
      if (entry.children) flattenEntries(entry.children, result);
      continue;
    }

    result.push({
      id: `file:${entry.relative_path}`,
      label: displayName(entry.name),
      category: "file",
      description: entry.relative_path,
      action: async () => {
        // Route via openFileRouted so binary files (images, office
        // docs, etc.) open in the right way when the user selects
        // them from the palette's fuzzy file search.
        await openFileRouted(entry.relative_path);
      },
    });
  }

  return result;
}

export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const mode = (): CommandPaletteMode => props.mode ?? "commands";
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  // Ref to the scrollable results list so arrow-key navigation can
  // scroll the selected item into view even when it's beyond the
  // visible area. Without this the selection would jump off-screen
  // and the user would have no idea why `Enter` opened a file they
  // couldn't see.
  let listRef: HTMLDivElement | undefined;

  const commands = createMemo<PaletteItem[]>(() => [
    {
      id: "cmd:ai-control",
      label: t("commandPalette.aiControl"),
      category: "command",
      description: t("commandPalette.aiControlDescription"),
      shortcut: configuredHotkey("ai-control"),
      action: () => {
        props.onClose();
        document.dispatchEvent(new CustomEvent("mindzj:toggle-ai-panel"));
      },
    },
    {
      id: "cmd:new-note",
      label: t("commandPalette.newNote"),
      category: "command",
      description: t("commandPalette.newNoteDescription"),
      shortcut: configuredHotkey("new-note"),
      action: async () => {
        const rawName = await promptDialog(t("fileTree.noteNamePrompt"), t("fileTree.newNoteDefault"));
        const noteName = rawName?.trim();
        if (!noteName) return;
        const name = noteName.endsWith(".md") ? noteName : `${noteName}.md`;
        await vaultStore.createFile(name, "");
        await vaultStore.openFile(name);
      },
    },
    {
      id: "cmd:toggle-theme",
      label: t("commandPalette.toggleTheme"),
      category: "command",
      description: t("commandPalette.toggleThemeDescription"),
      shortcut: configuredHotkey("toggle-theme"),
      action: () => {
        settingsStore.toggleTheme();
      },
    },
    {
      id: "cmd:toggle-view",
      label: t("commandPalette.toggleView"),
      category: "command",
      description: t("commandPalette.toggleViewDescription"),
      shortcut: configuredHotkey("toggle-view-mode"),
      action: () => {
        editorStore.cycleViewMode();
      },
    },
    {
      id: "cmd:reload-tree",
      label: t("commandPalette.reloadTree"),
      category: "command",
      description: t("common.refresh"),
      shortcut: configuredHotkey("reload-tree"),
      action: async () => {
        await vaultStore.refreshFileTree();
      },
    },
    ...listPluginCommands().map((cmd) => ({
      id: `plugin:${cmd.id}`,
      label: cmd.name,
      category: "command" as const,
      description: cmd.id,
      shortcut: pluginCommandShortcut(cmd.id, cmd.hotkeys),
      action: async () => {
        await runPluginCommand(cmd.id);
      },
    })),
  ]);

  const filteredItems = createMemo<PaletteItem[]>(() => {
    const rawQuery = query().trim();
    const q = rawQuery.toLowerCase();

    // Mode-based item pool. Commands mode shows only commands;
    // files mode shows only files (plus a synthetic "Create" item
    // when the query doesn't match an existing file name).
    const currentMode = mode();
    const base: PaletteItem[] =
      currentMode === "commands"
        ? commands()
        : flattenEntries(vaultStore.fileTree());

    const matched = !q
      ? base.slice(0, 50)
      : base
          .filter((item) => {
            const target = `${item.label} ${item.description || ""} ${item.shortcut || ""}`.toLowerCase();
            return q.split("").every((char) => target.includes(char));
          })
          .slice(0, 200);

    // In files mode: offer a "Create new note" action at the top
    // whenever the user's typed query isn't already an exact
    // filename match. This is the "or create" half of the
    // Ctrl+O = "Find or create note" workflow.
    if (currentMode === "files" && rawQuery.length > 0) {
      const lowered = rawQuery.toLowerCase();
      const exists = matched.some((item) => {
        if (item.category !== "file") return false;
        const candidate = item.label.toLowerCase();
        return (
          candidate === lowered ||
          candidate === `${lowered}.md` ||
          item.description?.toLowerCase() === lowered
        );
      });
      if (!exists) {
        const fileName = rawQuery.toLowerCase().endsWith(".md")
          ? rawQuery
          : `${rawQuery}.md`;
        const createItem: PaletteItem = {
          id: `create:${fileName}`,
          label: t("commandPalette.createNote", { name: fileName }),
          category: "create",
          description: t("commandPalette.createNoteDescription"),
          action: async () => {
            await vaultStore.createFile(fileName, "");
            await vaultStore.openFile(fileName);
          },
        };
        return [createItem, ...matched];
      }
    }

    return matched;
  });

  const runSelected = async () => {
    const item = filteredItems()[selectedIndex()];
    if (!item) return;
    await item.action();
    props.onClose();
  };

  onMount(() => {
    inputRef?.focus();

    const scrollSelectedIntoView = () => {
      // Defer to next frame so the DOM has rendered the new
      // selection highlight before we ask the browser to scroll.
      requestAnimationFrame(() => {
        if (!listRef) return;
        const el = listRef.querySelector<HTMLElement>(
          `[data-palette-index="${selectedIndex()}"]`,
        );
        if (!el) return;
        // Use block: "nearest" so we only scroll the minimum amount
        // needed — never scroll if the element is already visible,
        // only scroll just enough to get it inside the viewport.
        // This matches the behaviour of VS Code's command palette.
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }

      const items = filteredItems();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        // Wrap around at the bottom so pressing Down at the last
        // item jumps to the first. This is what power users expect
        // and is cheap to implement.
        setSelectedIndex((current) =>
          items.length === 0
            ? 0
            : current >= items.length - 1
              ? 0
              : current + 1,
        );
        scrollSelectedIntoView();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) =>
          items.length === 0
            ? 0
            : current <= 0
              ? items.length - 1
              : current - 1,
        );
        scrollSelectedIntoView();
      } else if (event.key === "Home") {
        event.preventDefault();
        setSelectedIndex(0);
        scrollSelectedIntoView();
      } else if (event.key === "End") {
        event.preventDefault();
        setSelectedIndex(Math.max(0, items.length - 1));
        scrollSelectedIntoView();
      } else if (event.key === "Enter") {
        event.preventDefault();
        void runSelected();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    onCleanup(() => document.removeEventListener("keydown", handleKeyDown));
  });

  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        "z-index": "9999",
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        // Use percentages instead of fixed vh/px so the palette
        // tracks window resizes live. At the tiniest sensible size
        // (320px window) the palette still has ~280px of usable
        // width thanks to the margin, and at 4K the 720px max cap
        // stops it from stretching ridiculously wide.
        "padding-top": "10vh",
        "padding-bottom": "10vh",
        "padding-left": "20px",
        "padding-right": "20px",
      }}
    >
      <div
        onClick={props.onClose}
        style={{
          position: "absolute",
          inset: "0",
          background: "rgba(0, 0, 0, 0.5)",
        }}
      />

      <div
        style={{
          position: "relative",
          // Adaptive width: grows to fill the available horizontal
          // space minus the 20px padding on each side, up to a
          // reasonable max that keeps long paths readable.
          width: "min(720px, 100%)",
          // Adaptive height: the outer flex column sets a total of
          // 80vh (100 - 10 - 10) available to the palette; let it
          // fill that, with a min of 300px so it never collapses.
          "max-height": "80vh",
          "min-height": "200px",
          background: "var(--mz-bg-secondary)",
          border: "1px solid var(--mz-border-strong)",
          "border-radius": "var(--mz-radius-lg)",
          "box-shadow": "0 16px 48px rgba(0, 0, 0, 0.3)",
          overflow: "hidden",
          display: "flex",
          "flex-direction": "column",
        }}
      >
        <div
          style={{
            padding: "var(--mz-space-3)",
            "border-bottom": "1px solid var(--mz-border)",
          }}
        >
          <input
            ref={inputRef}
            type="text"
            placeholder={
              mode() === "files"
                ? t("commandPalette.filePlaceholder")
                : t("commandPalette.commandPlaceholder")
            }
            value={query()}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setSelectedIndex(0);
            }}
            style={{
              width: "100%",
              padding: "8px 12px",
              border: "none",
              background: "var(--mz-bg-primary)",
              color: "var(--mz-text-primary)",
              "font-size": "var(--mz-font-size-base)",
              "border-radius": "var(--mz-radius-md)",
              outline: "none",
              "font-family": "var(--mz-font-sans)",
            }}
          />
        </div>

        <div
          ref={listRef}
          style={{
            // Flex-grow the result list so it fills all remaining
            // vertical space inside the 80vh-capped palette. This is
            // what makes the palette adaptive — small windows get a
            // short list, big windows get a tall list, but we always
            // honor the viewport without hard-coding pixels.
            flex: "1",
            "min-height": "0",
            overflow: "auto",
            padding: "var(--mz-space-1) 0",
          }}
        >
          <For each={filteredItems()}>
            {(item, index) => (
              <div
                data-palette-index={index()}
                onClick={async () => {
                  await item.action();
                  props.onClose();
                }}
                onMouseEnter={() => setSelectedIndex(index())}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "var(--mz-space-3)",
                  padding: "6px var(--mz-space-4)",
                  cursor: "pointer",
                  background:
                    selectedIndex() === index()
                      ? "var(--mz-bg-hover)"
                      : "transparent",
                }}
              >
                <span
                  style={{
                    width: "16px",
                    "text-align": "center",
                    "flex-shrink": "0",
                    color:
                      item.category === "create"
                        ? "var(--mz-success)"
                        : item.category === "file"
                          ? "var(--mz-accent)"
                          : "var(--mz-text-muted)",
                  }}
                >
                  {item.category === "create"
                    ? "+"
                    : item.category === "file"
                      ? "📄"
                      : "⌘"}
                </span>

                <div style={{ flex: "1", "min-width": "0" }}>
                  <div
                    style={{
                      overflow: "hidden",
                      "text-overflow": "ellipsis",
                      "white-space": "nowrap",
                      color: "var(--mz-text-primary)",
                      "font-size": "var(--mz-font-size-sm)",
                    }}
                  >
                    {item.label}
                  </div>
                  <Show when={item.description}>
                    <div
                      style={{
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                        color: "var(--mz-text-muted)",
                        "font-size": "var(--mz-font-size-xs)",
                      }}
                    >
                      {item.description}
                    </div>
                  </Show>
                </div>
                <Show when={item.shortcut}>
                  <span
                    style={{
                      "flex-shrink": "0",
                      color: "var(--mz-text-muted)",
                      "font-size": "var(--mz-font-size-xs)",
                      border: "1px solid var(--mz-border)",
                      "border-radius": "var(--mz-radius-sm)",
                      padding: "2px 6px",
                      background: "var(--mz-bg-primary)",
                      "font-family": "var(--mz-font-sans)",
                    }}
                  >
                    {item.shortcut}
                  </span>
                </Show>
              </div>
            )}
          </For>

          <Show when={filteredItems().length === 0}>
            <div
              style={{
                padding: "var(--mz-space-6)",
                "text-align": "center",
                color: "var(--mz-text-muted)",
                "font-size": "var(--mz-font-size-sm)",
              }}
            >
              {t("commandPalette.noResults")}
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

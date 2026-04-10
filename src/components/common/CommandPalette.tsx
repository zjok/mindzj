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
import { t } from "../../i18n";

interface PaletteItem {
  id: string;
  label: string;
  category: "file" | "command";
  description?: string;
  action: () => void | Promise<void>;
}

interface CommandPaletteProps {
  onClose: () => void;
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
        await vaultStore.openFile(entry.relative_path);
      },
    });
  }

  return result;
}

export const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal("");
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  const commands = createMemo<PaletteItem[]>(() => [
    {
      id: "cmd:new-note",
      label: t("commandPalette.newNote"),
      category: "command",
      description: t("commandPalette.newNoteDescription"),
      action: async () => {
        const name = `${t("commandPalette.untitled")}_${Date.now()}.md`;
        await vaultStore.createFile(name, "");
        await vaultStore.openFile(name);
      },
    },
    {
      id: "cmd:toggle-theme",
      label: t("commandPalette.toggleTheme"),
      category: "command",
      description: t("commandPalette.toggleThemeDescription"),
      action: () => {
        settingsStore.toggleTheme();
      },
    },
    {
      id: "cmd:toggle-view",
      label: t("commandPalette.toggleView"),
      category: "command",
      description: t("commandPalette.toggleViewDescription"),
      action: () => {
        editorStore.cycleViewMode();
      },
    },
    {
      id: "cmd:reload-tree",
      label: t("commandPalette.reloadTree"),
      category: "command",
      description: t("common.refresh"),
      action: async () => {
        await vaultStore.refreshFileTree();
      },
    },
    ...listPluginCommands().map((cmd) => ({
      id: `plugin:${cmd.id}`,
      label: cmd.name,
      category: "command" as const,
      description: cmd.id,
      action: async () => {
        await runPluginCommand(cmd.id);
      },
    })),
  ]);

  const filteredItems = createMemo(() => {
    const q = query().toLowerCase().trim();
    const items = [...commands(), ...flattenEntries(vaultStore.fileTree())];

    if (!q) {
      return items.slice(0, 20);
    }

    return items
      .filter((item) => {
        const target = `${item.label} ${item.description || ""}`.toLowerCase();
        return q.split("").every((char) => target.includes(char));
      })
      .slice(0, 20);
  });

  const runSelected = async () => {
    const item = filteredItems()[selectedIndex()];
    if (!item) return;
    await item.action();
    props.onClose();
  };

  onMount(() => {
    inputRef?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }

      const items = filteredItems();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => Math.min(current + 1, items.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((current) => Math.max(current - 1, 0));
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
        "justify-content": "center",
        "padding-top": "15vh",
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
          width: "540px",
          "max-width": "90vw",
          background: "var(--mz-bg-secondary)",
          border: "1px solid var(--mz-border-strong)",
          "border-radius": "var(--mz-radius-lg)",
          "box-shadow": "0 16px 48px rgba(0, 0, 0, 0.3)",
          overflow: "hidden",
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
            placeholder={t("commandPalette.placeholder")}
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
          style={{
            "max-height": "320px",
            overflow: "auto",
            padding: "var(--mz-space-1) 0",
          }}
        >
          <For each={filteredItems()}>
            {(item, index) => (
              <div
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
                      item.category === "file"
                        ? "var(--mz-accent)"
                        : "var(--mz-text-muted)",
                  }}
                >
                  {item.category === "file" ? "📄" : "⌘"}
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

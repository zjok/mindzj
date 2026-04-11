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

    // Previously capped at 20 unconditionally. That made the arrow
    // keys unable to reach item #21+ even though the scroll area
    // could hold them, so I relaxed the cap: show the first 50 when
    // there's no query (so the palette doesn't take seconds to
    // render on vaults with thousands of files), and the first 200
    // filtered matches when the user is typing — that's plenty of
    // fuzzy-match results in practice.
    if (!q) {
      return items.slice(0, 50);
    }

    return items
      .filter((item) => {
        const target = `${item.label} ${item.description || ""}`.toLowerCase();
        return q.split("").every((char) => target.includes(char));
      })
      .slice(0, 200);
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

import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { vaultStore } from "../../stores/vault";
import { editorStore } from "../../stores/editor";
import { settingsStore } from "../../stores/settings";

interface NoteLink {
  source: string;
  target: string;
  display_text: string | null;
  link_type: string;
  line: number;
}

export const StatusBar: Component = () => {
  const [backlinks, setBacklinks] = createSignal<NoteLink[]>([]);
  const [showPopover, setShowPopover] = createSignal(false);
  let popoverRef: HTMLDivElement | undefined;
  let triggerRef: HTMLSpanElement | undefined;

  createEffect(
    on(
      () => vaultStore.activeFile()?.path,
      async (path) => {
        if (!path) {
          setBacklinks([]);
          return;
        }

        try {
          const response = await invoke<NoteLink[]>("get_backlinks", {
            relativePath: path,
          });
          setBacklinks(response);
        } catch {
          setBacklinks([]);
        }
      },
    ),
  );

  const grouped = () => {
    const map = new Map<string, NoteLink[]>();
    for (const link of backlinks()) {
      const list = map.get(link.source) || [];
      list.push(link);
      map.set(link.source, list);
    }
    return [...map.entries()];
  };

  const displayName = (path: string) =>
    path.replace(/\.md$/, "").split("/").pop() ?? path;

  const handleOutsideClick = (event: MouseEvent) => {
    if (
      popoverRef &&
      !popoverRef.contains(event.target as Node) &&
      triggerRef &&
      !triggerRef.contains(event.target as Node)
    ) {
      setShowPopover(false);
    }
  };

  createEffect(() => {
    if (showPopover()) {
      document.addEventListener("mousedown", handleOutsideClick);
    } else {
      document.removeEventListener("mousedown", handleOutsideClick);
    }
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleOutsideClick);
  });

  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        height: "var(--mz-statusbar-height)",
        "min-height": "var(--mz-statusbar-height)",
        padding: "0 var(--mz-space-4)",
        background: "var(--mz-bg-secondary)",
        "border-top": "1px solid var(--mz-border)",
        "font-size": "var(--mz-font-size-xs)",
        color: "var(--mz-text-muted)",
        gap: "var(--mz-space-4)",
        position: "relative",
      }}
    >
      <Show when={editorStore.isDirty()}>
        <span style={{ color: "var(--mz-warning)" }}>{t("status.unsaved")}</span>
      </Show>
      <Show when={!editorStore.isDirty() && vaultStore.activeFile()}>
        <span style={{ color: "var(--mz-success)" }}>{t("status.saved")}</span>
      </Show>

      <div style={{ flex: "1" }} />

      <Show when={vaultStore.activeFile()}>
        <span
          ref={triggerRef}
          onClick={() => setShowPopover((value) => !value)}
          style={{
            cursor: backlinks().length > 0 ? "pointer" : "default",
            color:
              backlinks().length > 0
                ? "var(--mz-accent)"
                : "var(--mz-text-muted)",
          }}
          onMouseEnter={(event) => {
            if (backlinks().length > 0) {
              event.currentTarget.style.textDecoration = "underline";
            }
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.textDecoration = "none";
          }}
        >
          {t("status.backlinkCount", { count: backlinks().length })}
        </span>
      </Show>

      <Show when={showPopover() && backlinks().length > 0}>
        <div
          ref={popoverRef}
          style={{
            position: "absolute",
            bottom: "calc(var(--mz-statusbar-height) + 4px)",
            right: "var(--mz-space-4)",
            width: "280px",
            "max-height": "320px",
            "overflow-y": "auto",
            background: "var(--mz-bg-secondary)",
            border: "1px solid var(--mz-border-strong)",
            "border-radius": "var(--mz-radius-md, 6px)",
            "box-shadow": "0 8px 28px rgba(0,0,0,0.3)",
            padding: "8px 0",
            "font-size": "var(--mz-font-size-sm)",
            "z-index": "9999",
          }}
        >
          <div
            style={{
              padding: "4px 12px 8px",
              "font-weight": "600",
              color: "var(--mz-text-secondary)",
              "border-bottom": "1px solid var(--mz-border)",
              "margin-bottom": "4px",
            }}
          >
            {t("status.backlinksTitle", { count: backlinks().length })}
          </div>
          <For each={grouped()}>
            {([source]) => (
              <div
                onClick={() => {
                  void vaultStore.openFile(source);
                  setShowPopover(false);
                }}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "6px",
                  padding: "5px 12px",
                  cursor: "pointer",
                  color: "var(--mz-text-primary)",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = "var(--mz-bg-hover)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  style={{ "flex-shrink": "0" }}
                >
                  <path
                    d="M4 1.5h5.586a1 1 0 01.707.293l2.914 2.914a1 1 0 01.293.707V13.5a1 1 0 01-1 1H4a1 1 0 01-1-1v-11a1 1 0 011-1z"
                    stroke="var(--mz-accent)"
                    stroke-width="1"
                    fill="none"
                  />
                </svg>
                <span
                  style={{
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    "white-space": "nowrap",
                  }}
                >
                  {displayName(source)}
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={vaultStore.activeFile()}>
        <span>
          {t("status.lineColumn", {
            line: editorStore.cursorLine(),
            column: editorStore.cursorCol(),
          })}
        </span>
      </Show>

      <Show when={vaultStore.activeFile()}>
        <span>
          {t("status.wordCharCount", {
            words: editorStore.wordCount(),
            chars: editorStore.charCount(),
          })}
        </span>
      </Show>

      <Show when={editorStore.uiZoom() !== 100}>
        <span>UI {editorStore.uiZoom()}%</span>
      </Show>

      <button
        onClick={() => settingsStore.toggleTheme()}
        title={t("status.toggleTheme")}
        style={{
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          width: "20px",
          height: "20px",
          border: "none",
          background: "transparent",
          color: "var(--mz-text-muted)",
          cursor: "pointer",
          "border-radius": "var(--mz-radius-sm)",
          "font-size": "12px",
          padding: "0",
        }}
        onMouseEnter={(event) => {
          event.currentTarget.style.color = "var(--mz-text-primary)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = "var(--mz-text-muted)";
        }}
      >
        {settingsStore.settings().theme === "dark" ? "☾" : "☀"}
      </button>
    </div>
  );
};

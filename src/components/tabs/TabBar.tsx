import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { Portal } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { editorStore, type ViewMode } from "../../stores/editor";
import type { FileContent } from "../../stores/vault";
import { displayName } from "../../utils/displayName";

// Tab width bounds. Each tab sizes itself to its filename via
// `computeTabWidth` below; these constants just cap the result.
//
//   - MIN_WIDTH: short names (`a`, `b`) still get a usable click
//     target.
//   - MAX_WIDTH: very long names ("A Very Long Filename That Would
//     Overflow Everything Else.md") stop growing past this and
//     start truncating with `…` via `text-overflow: ellipsis` on
//     the inner span.
const TAB_MIN_WIDTH = 80;
const TAB_MAX_WIDTH = 240;
const TAB_TOOLTIP_DELAY_MS = 1000;

// Fixed padding budget for the non-text parts of the tab:
//   10px left + 10px right padding  = 20
//   16px close button               = 16
//    6px gap between text & close   =  6
//   14px breathing room / slop      = 14
//                                   = 56
// The extra 14px "slop" exists because browser text rendering adds
// small amounts of sub-pixel padding and kerning-slack that a
// naive `measureText`/`offsetWidth` call doesn't always capture.
// Without it, filenames like `2026-04-11` lose their trailing `1`
// to text-overflow because the tab is 1-2px too narrow.
//
// When the file is dirty, also budget for the unsaved dot:
//   6px unsaved dot + 6px gap = 12
const TAB_PADDING_BASE = 56;
const TAB_PADDING_DIRTY = 12;

// Hidden measuring span. Created lazily on first `measureTabText`
// call, reused for every subsequent measurement. It lives in the
// document body with the same inherited font as the real tab bar
// so `getBoundingClientRect()` reports the exact rendered width.
let _measureSpan: HTMLSpanElement | null = null;

function ensureMeasureSpan(): HTMLSpanElement | null {
    if (_measureSpan && _measureSpan.isConnected) return _measureSpan;
    if (typeof document === "undefined") return null;
    try {
        const span = document.createElement("span");
        // The tab inner span doesn't set its own font-family, so it
        // inherits from <body>. Copy the body's COMPUTED font so our
        // measurement span renders with the exact same resolved font
        // stack Windows picked for the actual tabs (which is usually
        // Segoe UI on Windows, but could be Inter if that loads, or
        // PingFang SC for CJK fallback, etc.). Font size is fixed to
        // 13px to match `--mz-font-size-sm`.
        const bodyStyle = getComputedStyle(document.body);
        span.style.cssText = [
            "position: absolute",
            "top: -9999px",
            "left: -9999px",
            "visibility: hidden",
            "pointer-events: none",
            "white-space: nowrap",
            "font-size: 13px",
            `font-family: ${bodyStyle.fontFamily}`,
            `font-weight: ${bodyStyle.fontWeight}`,
            "letter-spacing: normal",
        ].join(";");
        document.body.appendChild(span);
        _measureSpan = span;
        return span;
    } catch {
        return null;
    }
}

/**
 * Measure the rendered pixel width of a filename in the tab bar's
 * actual font. Uses an offscreen <span> + `getBoundingClientRect`
 * so the measurement matches what the browser will actually draw,
 * including CJK fallback font metrics (Segoe UI → PingFang SC).
 *
 * Falls back to a crude `length * 9` estimate if the DOM isn't
 * available (shouldn't happen in Tauri but costs nothing to guard).
 */
function measureTabText(text: string): number {
    const span = ensureMeasureSpan();
    if (!span) return text.length * 9;
    span.textContent = text;
    // `getBoundingClientRect` gives fractional widths; round up so
    // the tab is never 0.3px short of fitting its text.
    return Math.ceil(span.getBoundingClientRect().width);
}

/**
 * Compute the tab width for a given filename. Measures the text
 * via the hidden span above, adds a fixed padding budget, and
 * clamps to [`TAB_MIN_WIDTH`, `TAB_MAX_WIDTH`].
 */
function computeTabWidth(name: string, isDirty: boolean): number {
    const textWidth = measureTabText(name);
    const padding = TAB_PADDING_BASE + (isDirty ? TAB_PADDING_DIRTY : 0);
    const raw = textWidth + padding;
    return Math.max(TAB_MIN_WIDTH, Math.min(TAB_MAX_WIDTH, raw));
}

type SplitDirection = "left" | "right" | "up" | "down";

interface TabBarProps {
  files: FileContent[];
  activeFile: FileContent | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder?: (fromIdx: number, toIdx: number) => void;
  onOpenSplit?: (path: string, direction: SplitDirection) => void;
  onSetViewMode?: (path: string, mode: ViewMode) => void;
  onRevealInTree?: (path: string) => void;
}

interface ContextMenuItem {
  label: string;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
  selected?: boolean;
  separator?: never;
}

interface ContextSeparator {
  separator: true;
  label?: never;
  onClick?: never;
}

type ContextEntry = ContextMenuItem | ContextSeparator;

export const TabBar: Component<TabBarProps> = (props) => {
  const [dragIdx, setDragIdx] = createSignal<number | null>(null);
  const [dropIdx, setDropIdx] = createSignal<number | null>(null);
  const [dropSide, setDropSide] = createSignal<"before" | "after">("before");
  const [ctxMenu, setCtxMenu] = createSignal<{
    x: number;
    y: number;
    entries: ContextEntry[];
  } | null>(null);
  const [tooltip, setTooltip] = createSignal<{
    fullPath: string;
    x: number;
    y: number;
    placement: "top" | "bottom";
  } | null>(null);

  let scrollRef: HTMLDivElement | undefined;
  let dragging = false;
  let dragFromIdx = -1;
  let dragStartX = 0;
  let dragStartY = 0;
  const dragThreshold = 5;
  let tooltipTimer: ReturnType<typeof setTimeout> | null = null;

  const closeContextMenu = () => setCtxMenu(null);
  const clearTooltipTimer = () => {
    if (tooltipTimer) {
      clearTimeout(tooltipTimer);
      tooltipTimer = null;
    }
  };
  const closeTooltip = () => {
    clearTooltipTimer();
    setTooltip(null);
  };

  const dismissHandler = (event: Event) => {
    if (event instanceof KeyboardEvent && event.key !== "Escape") return;
    closeContextMenu();
    closeTooltip();
  };

  createEffect(() => {
    if (!ctxMenu()) return;
    window.addEventListener("click", dismissHandler, true);
    window.addEventListener("wheel", dismissHandler, true);
    window.addEventListener("keydown", dismissHandler, true);
    onCleanup(() => {
      window.removeEventListener("click", dismissHandler, true);
      window.removeEventListener("wheel", dismissHandler, true);
      window.removeEventListener("keydown", dismissHandler, true);
    });
  });

  const fileName = (path: string) => displayName(path);

  const buildContextEntries = (index: number): ContextEntry[] => {
    const file = props.files[index];
    if (!file) return [];

    const isActive = props.activeFile?.path === file.path;
    const closeTab = () => props.onClose(file.path);
    const closeOthers = () => {
      for (const openFile of [...props.files]) {
        if (openFile.path !== file.path) props.onClose(openFile.path);
      }
    };
    const closeToRight = () => {
      const startIndex = props.files.findIndex((entry) => entry.path === file.path);
      if (startIndex < 0) return;
      for (const openFile of props.files.slice(startIndex + 1).reverse()) {
        props.onClose(openFile.path);
      }
    };
    const closeAll = () => {
      for (const openFile of [...props.files]) props.onClose(openFile.path);
    };
    const revealInTree = () => {
      props.onRevealInTree?.(file.path);
    };
    const showInFileManager = () => {
      void invoke("reveal_in_file_manager", {
        relativePath: file.path,
      }).catch((error) => {
        console.warn("[TabBar] Failed to reveal file in file manager:", error);
      });
    };
    const setViewMode = (mode: ViewMode) => props.onSetViewMode?.(file.path, mode);
    const currentMode = editorStore.getViewModeForFile(file.path);

    const entries: ContextEntry[] = [];
    if (!isActive) {
      entries.push({ label: t("context.switchToTab"), onClick: () => props.onSelect(file.path) });
      entries.push({ separator: true });
    }
    entries.push({ label: t("context.closeTab"), shortcut: "Ctrl+W", onClick: closeTab });
    entries.push({ label: t("context.closeOtherTabs"), onClick: closeOthers });
    entries.push({ label: t("context.closeTabsToRight"), onClick: closeToRight });
    entries.push({ label: t("context.closeAllTabs"), onClick: closeAll, danger: true });
    entries.push({ separator: true });
    entries.push({ label: t("context.revealInTree"), onClick: revealInTree });
    entries.push({ label: t("context.showInExplorer"), onClick: showInFileManager });
    if (props.onSetViewMode) {
      entries.push({ separator: true });
      entries.push({
        label: t("context.readingView"),
        onClick: () => setViewMode("reading"),
        selected: currentMode === "reading",
      });
      entries.push({
        label: t("context.editMode"),
        onClick: () => setViewMode("live-preview"),
        selected: currentMode === "live-preview",
      });
      entries.push({
        label: t("context.sourceMode"),
        onClick: () => setViewMode("source"),
        selected: currentMode === "source",
      });
    }
    if (props.onOpenSplit) {
      entries.push({ separator: true });
      entries.push({ label: t("context.splitRight"), onClick: () => props.onOpenSplit?.(file.path, "right") });
      entries.push({ label: t("context.splitLeft"), onClick: () => props.onOpenSplit?.(file.path, "left") });
      entries.push({ label: t("context.splitDown"), onClick: () => props.onOpenSplit?.(file.path, "down") });
      entries.push({ label: t("context.splitUp"), onClick: () => props.onOpenSplit?.(file.path, "up") });
    }
    return entries;
  };

  const openContextMenu = (event: MouseEvent, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    closeTooltip();
    setCtxMenu({ x: event.clientX, y: event.clientY, entries: buildContextEntries(index) });
  };

  const getContextMenuLeft = () => {
    const menu = ctxMenu();
    if (!menu) return 0;
    const menuWidth = 220;
    return Math.max(8, Math.min(menu.x, window.innerWidth - menuWidth - 8));
  };

  const getContextMenuTop = () => {
    const menu = ctxMenu();
    if (!menu) return 0;
    const separatorCount = menu.entries.filter((entry) => "separator" in entry && entry.separator).length;
    const itemCount = menu.entries.length - separatorCount;
    const estimatedHeight = itemCount * 34 + separatorCount * 9 + 8;
    return Math.max(8, Math.min(menu.y, window.innerHeight - estimatedHeight - 8));
  };

  const scheduleTooltip = (path: string, element: HTMLElement) => {
    closeTooltip();
    tooltipTimer = setTimeout(() => {
      const rect = element.getBoundingClientRect();
      const showBelow = rect.bottom + 44 <= window.innerHeight;
      setTooltip({
        fullPath: path,
        x: rect.left + rect.width / 2,
        y: showBelow ? rect.bottom + 8 : rect.top - 8,
        placement: showBelow ? "bottom" : "top",
      });
      tooltipTimer = null;
    }, TAB_TOOLTIP_DELAY_MS);
  };

  const scrollActiveIntoView = () => {
    if (!scrollRef) return;
    const activeTab = scrollRef.querySelector("[data-tab-idx].mz-tab-active") as HTMLElement | null;
    if (!activeTab) return;

    const barRect = scrollRef.getBoundingClientRect();
    const tabRect = activeTab.getBoundingClientRect();
    if (tabRect.left < barRect.left) {
      scrollRef.scrollLeft -= barRect.left - tabRect.left + 8;
    } else if (tabRect.right > barRect.right) {
      scrollRef.scrollLeft += tabRect.right - barRect.right + 8;
    }
  };

  createEffect(() => {
    props.activeFile?.path;
    props.files.length;
    requestAnimationFrame(scrollActiveIntoView);
  });

  onCleanup(() => {
    clearTooltipTimer();
  });

  const onTabPointerDown = (event: PointerEvent, index: number) => {
    if (event.button !== 0) return;

    dragFromIdx = index;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragging = false;

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - dragStartX;
      const dy = moveEvent.clientY - dragStartY;

      if (!dragging && (Math.abs(dx) > dragThreshold || Math.abs(dy) > dragThreshold)) {
        dragging = true;
        setDragIdx(dragFromIdx);
      }

      if (!dragging || !scrollRef) return;

      const tabs = scrollRef.querySelectorAll<HTMLElement>("[data-tab-idx]");
      let matched = false;
      for (let tabIndex = 0; tabIndex < tabs.length; tabIndex += 1) {
        const rect = tabs[tabIndex].getBoundingClientRect();
        if (moveEvent.clientX < rect.left || moveEvent.clientX >= rect.right) continue;

        const midpoint = rect.left + rect.width / 2;
        const side = moveEvent.clientX < midpoint ? "before" : "after";
        setDropSide(side);
        setDropIdx(tabIndex === dragFromIdx ? null : tabIndex);
        matched = true;
        break;
      }

      if (!matched && tabs.length > 0) {
        const lastRect = tabs[tabs.length - 1].getBoundingClientRect();
        if (moveEvent.clientX >= lastRect.right) {
          const lastIndex = tabs.length - 1;
          setDropSide("after");
          setDropIdx(lastIndex === dragFromIdx ? null : lastIndex);
        }
      }
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);

      if (dragging) {
        const target = dropIdx();
        if (target !== null && props.onReorder) {
          const side = dropSide();
          let targetIndex = target;

          if (dragFromIdx < target) {
            if (side === "before") targetIndex = target - 1;
          } else if (dragFromIdx > target) {
            if (side === "after") targetIndex = target + 1;
          }

          if (targetIndex !== dragFromIdx) {
            props.onReorder(dragFromIdx, targetIndex);
          }
        }
      }

      dragging = false;
      dragFromIdx = -1;
      setDragIdx(null);
      setDropIdx(null);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  };

  return (
    <div
      style={{
        display: "flex",
        "align-items": "center",
        height: "var(--mz-tab-height)",
        "min-height": "var(--mz-tab-height)",
        background: "var(--mz-bg-secondary)",
        "border-bottom": "1px solid var(--mz-border)",
        overflow: "hidden",
        width: "100%",
      }}
    >
      <div
        ref={scrollRef}
        data-tauri-drag-region
        style={{
          display: "flex",
          flex: "1 1 auto",
          overflow: "auto hidden",
          "scrollbar-width": "none",
          height: "100%",
          "align-items": "center",
          "min-width": "0",
          "-webkit-app-region": "drag",
        }}
        onWheel={(event) => {
          if (!scrollRef) return;
          closeTooltip();
          scrollRef.scrollLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX;
          event.preventDefault();
        }}
      >
        <For each={props.files}>
          {(file, index) => {
            const isActive = () => props.activeFile?.path === file.path;
            // Dynamic per-tab width: recomputed whenever the filename
            // OR the dirty state changes. Wrapped as an arrow fn so
            // Solid's fine-grained reactivity re-runs it on signal
            // updates (both `fileName(...)` which depends on the
            // path and `editorStore.isDirtyPath(...)` which is a
            // reactive store accessor).
            const tabWidth = () =>
              computeTabWidth(
                fileName(file.path),
                editorStore.isDirtyPath(file.path),
              );

            return (
              <div
                data-tab-idx={index()}
                classList={{ "mz-tab-active": isActive() }}
                onPointerDown={(event) => {
                  closeTooltip();
                  onTabPointerDown(event, index());
                }}
                onClick={() => {
                  closeTooltip();
                  if (!dragging) props.onSelect(file.path);
                }}
                onContextMenu={(event) => openContextMenu(event, index())}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "6px",
                  padding: "0 10px",
                  height: "100%",
                  width: `${tabWidth()}px`,
                  "min-width": `${TAB_MIN_WIDTH}px`,
                  "max-width": `${TAB_MAX_WIDTH}px`,
                  "font-size": "var(--mz-font-size-sm)",
                  color: isActive()
                    ? "var(--mz-text-primary)"
                    : "var(--mz-text-secondary)",
                  background: isActive() ? "var(--mz-bg-primary)" : "transparent",
                  "border-right":
                    dropIdx() === index() && dropSide() === "after"
                      ? "2px solid var(--mz-accent)"
                      : "1px solid var(--mz-border)",
                  "border-left":
                    dropIdx() === index() && dropSide() === "before"
                      ? "2px solid var(--mz-accent)"
                      : "none",
                  cursor: "pointer",
                  "white-space": "nowrap",
                  "flex-shrink": "0",
                  position: "relative",
                  opacity: dragIdx() === index() ? "0.5" : "1",
                  "box-sizing": "border-box",
                  "-webkit-app-region": "no-drag",
                  "user-select": "none",
                  "touch-action": "none",
                }}
                onMouseEnter={(event) => {
                  scheduleTooltip(file.path, event.currentTarget);
                  if (!isActive()) {
                    event.currentTarget.style.background = "var(--mz-bg-hover)";
                  }
                }}
                onMouseLeave={(event) => {
                  closeTooltip();
                  if (!isActive()) {
                    event.currentTarget.style.background = "transparent";
                  }
                }}
              >
                <Show when={editorStore.isDirtyPath(file.path)}>
                  <span
                    title={t("tabs.unsaved")}
                    style={{
                      width: "6px",
                      height: "6px",
                      "border-radius": "50%",
                      background: "var(--mz-accent)",
                      "flex-shrink": "0",
                    }}
                  />
                </Show>

                <span
                  style={{
                    "pointer-events": "none",
                    overflow: "hidden",
                    "text-overflow": "ellipsis",
                    flex: "1",
                    "min-width": "0",
                  }}
                >
                  {fileName(file.path)}
                </span>

                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTooltip();
                    props.onClose(file.path);
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    closeTooltip();
                  }}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    width: "16px",
                    height: "16px",
                    border: "none",
                    background: "transparent",
                    color: "var(--mz-text-muted)",
                    cursor: "pointer",
                    "border-radius": "var(--mz-radius-sm)",
                    "font-size": "14px",
                    "line-height": "1",
                    padding: "0",
                    "flex-shrink": "0",
                  }}
                  onMouseEnter={(event) => {
                    event.currentTarget.style.background = "var(--mz-bg-active)";
                    event.currentTarget.style.color = "var(--mz-text-primary)";
                  }}
                  onMouseLeave={(event) => {
                    event.currentTarget.style.background = "transparent";
                    event.currentTarget.style.color = "var(--mz-text-muted)";
                  }}
                >
                  ×
                </button>

                <Show when={isActive()}>
                  <div
                    style={{
                      position: "absolute",
                      bottom: "0",
                      left: "0",
                      right: "0",
                      height: "2px",
                      background: "var(--mz-accent)",
                    }}
                  />
                </Show>
              </div>
            );
          }}
        </For>
      </div>

      <Portal>
        <Show when={ctxMenu()}>
          {(menu) => (
            <div
              onContextMenu={(event) => event.preventDefault()}
              style={{
                position: "fixed",
                top: `${getContextMenuTop()}px`,
                left: `${getContextMenuLeft()}px`,
                "min-width": "200px",
                background: "var(--mz-bg-secondary)",
                border: "1px solid var(--mz-border-strong)",
                "border-radius": "var(--mz-radius-md)",
                "box-shadow": "0 8px 24px rgba(0,0,0,0.35)",
                padding: "4px 0",
                "z-index": "2147483646",
                "font-size": "var(--mz-font-size-sm)",
                "font-family": "var(--mz-font-sans)",
                "user-select": "none",
              }}
            >
              <For each={menu().entries}>
                {(entry) => (
                  <Show
                    when={!("separator" in entry && entry.separator)}
                    fallback={
                      <div
                        style={{
                          height: "1px",
                          background: "var(--mz-border)",
                          margin: "4px 8px",
                        }}
                      />
                    }
                  >
                    <button
                      onClick={() => {
                        (entry as ContextMenuItem).onClick();
                        closeContextMenu();
                      }}
                      style={{
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "space-between",
                        gap: "24px",
                        width: "100%",
                        padding: "6px 14px",
                        border: "none",
                        background: (entry as ContextMenuItem).selected
                          ? "var(--mz-bg-hover)"
                          : "transparent",
                        color: (entry as ContextMenuItem).danger
                          ? "var(--mz-error)"
                          : "var(--mz-text-primary)",
                        cursor: "pointer",
                        "text-align": "left",
                        "font-size": "var(--mz-font-size-sm)",
                        "font-family": "var(--mz-font-sans)",
                      }}
                      onMouseEnter={(event) => {
                        event.currentTarget.style.background = "var(--mz-bg-hover)";
                      }}
                      onMouseLeave={(event) => {
                        event.currentTarget.style.background = (entry as ContextMenuItem).selected
                          ? "var(--mz-bg-hover)"
                          : "transparent";
                      }}
                    >
                      <span
                        style={{
                          display: "flex",
                          "align-items": "center",
                          gap: "8px",
                        }}
                      >
                        <span
                          style={{
                            width: "12px",
                            color: (entry as ContextMenuItem).selected
                              ? "var(--mz-accent)"
                              : "transparent",
                            "font-weight": "700",
                            "flex-shrink": "0",
                          }}
                        >
                          ✓
                        </span>
                        <span>{(entry as ContextMenuItem).label}</span>
                      </span>
                      <Show when={(entry as ContextMenuItem).shortcut}>
                        <span style={{ color: "var(--mz-text-muted)", "font-size": "0.85em" }}>
                          {(entry as ContextMenuItem).shortcut}
                        </span>
                      </Show>
                    </button>
                  </Show>
                )}
              </For>
            </div>
          )}
        </Show>

        <Show when={tooltip()}>
          {(tabTooltip) => (
            <div
              style={{
                position: "fixed",
                left: `${tabTooltip().x}px`,
                top: `${tabTooltip().y}px`,
                transform:
                  tabTooltip().placement === "bottom"
                    ? "translate(-50%, 0)"
                    : "translate(-50%, -100%)",
                padding: "6px 10px",
                "border-radius": "var(--mz-radius-sm)",
                background: "var(--mz-bg-tertiary)",
                border: "1px solid var(--mz-border-strong)",
                color: "var(--mz-text-primary)",
                "font-size": "var(--mz-font-size-xs)",
                "font-family": "var(--mz-font-sans)",
                "box-shadow": "0 6px 18px rgba(0,0,0,0.28)",
                "white-space": "normal",
                "max-width": "min(480px, calc(100vw - 16px))",
                "word-break": "break-word",
                "pointer-events": "none",
                "z-index": "2147483647",
              }}
            >
              {tabTooltip().fullPath}
            </div>
          )}
        </Show>
      </Portal>
    </div>
  );
};

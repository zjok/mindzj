import {
  Component,
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { t } from "../../i18n";
import { editorStore } from "../../stores/editor";
import { vaultStore } from "../../stores/vault";

interface ToolbarButton {
  command: string;
  icon: string;
  label: string;
  level?: number;
  separator?: boolean;
  shortcut?: string;
}

const TOOLBAR_ITEMS: ToolbarButton[] = [
  { icon: "↶", label: "toolbar.undo", command: "undo", shortcut: "Ctrl+Z" },
  {
    icon: "↷",
    label: "toolbar.redo",
    command: "redo",
    shortcut: "Ctrl+Shift+Z",
    separator: true,
  },
  {
    icon: "P",
    label: "toolbar.paragraph",
    command: "heading",
    shortcut: "Ctrl+0",
    level: 0,
  },
  ...Array.from({ length: 6 }, (_, index) => ({
    icon: `H${index + 1}`,
    label: "toolbar.heading",
    command: "heading",
    shortcut: `Ctrl+${index + 1}`,
    level: index + 1,
    separator: index === 5,
  })),
  { icon: "B", label: "toolbar.bold", command: "bold", shortcut: "Ctrl+B" },
  { icon: "I", label: "toolbar.italic", command: "italic", shortcut: "Ctrl+I" },
  {
    icon: "S",
    label: "toolbar.strikethrough",
    command: "strikethrough",
    shortcut: "Ctrl+Shift+S",
  },
  { icon: "U", label: "toolbar.underline", command: "underline", shortcut: "Ctrl+U" },
  {
    icon: "H",
    label: "toolbar.highlight",
    command: "highlight",
    shortcut: "Ctrl+Shift+H",
    separator: true,
  },
  { icon: "🔗", label: "toolbar.link", command: "link", shortcut: "Ctrl+K" },
  { icon: "</>", label: "toolbar.code", command: "code", shortcut: "Ctrl+Shift+E" },
  { icon: "{ }", label: "toolbar.codeBlock", command: "codeblock", separator: true },
  { icon: "▦", label: "toolbar.table", command: "table" },
  { icon: "—", label: "toolbar.separator", command: "horizontal-rule" },
  { icon: "☑", label: "toolbar.taskList", command: "task-list" },
  { icon: "•", label: "toolbar.bulletList", command: "bullet-list" },
  { icon: "1.", label: "toolbar.numberedList", command: "numbered-list" },
  { icon: "❝", label: "toolbar.quote", command: "quote" },
];

export const Toolbar: Component = () => {
  const [showHeadingMenu, setShowHeadingMenu] = createSignal(false);
  const [showOverflowMenu, setShowOverflowMenu] = createSignal(false);
  const [overflowIndex, setOverflowIndex] = createSignal<number>(-1);
  const [headingMenuPos, setHeadingMenuPos] = createSignal({ x: 0, y: 0 });
  let toolbarRef: HTMLDivElement | undefined;
  let itemsRef: HTMLDivElement | undefined;
  let headingBtnRef: HTMLButtonElement | undefined;
  let rightAreaRef: HTMLDivElement | undefined;

  const translateLabel = (item: ToolbarButton) =>
    item.label === "toolbar.heading"
      ? t(item.label, { level: item.level ?? 1 })
      : t(item.label);

  const dispatchCommand = (item: ToolbarButton) => {
    const detail: Record<string, any> = { command: item.command };
    if (item.command === "heading") detail.level = item.level ?? 2;
    document.dispatchEvent(new CustomEvent("mindzj:editor-command", { detail }));
  };

  const currentViewMode = () =>
    editorStore.getViewModeForFile(vaultStore.activeFile()?.path ?? null);
  const cycleToolbarViewMode = () =>
    editorStore.cycleViewMode(vaultStore.activeFile()?.path ?? undefined);
  const viewModeLabel = () => {
    switch (currentViewMode()) {
      case "source":
        return t("context.sourceMode");
      case "reading":
        return t("context.readingView");
      default:
        return t("context.editMode");
    }
  };

  const headingItems = createMemo(() =>
    TOOLBAR_ITEMS.filter((item) => item.command === "heading"),
  );
  const otherItems = createMemo(() =>
    TOOLBAR_ITEMS.filter((item) => item.command !== "heading"),
  );
  const flatOtherItems = createMemo(() => otherItems().slice(2));

  const checkOverflow = () => {
    if (!toolbarRef || !itemsRef || !rightAreaRef) return;

    const rightWidth = rightAreaRef.getBoundingClientRect().width + 8;
    const containerRight = toolbarRef.getBoundingClientRect().right - rightWidth;
    const children = itemsRef.querySelectorAll<HTMLElement>("[data-toolbar-idx]");
    let cutoff = -1;

    for (let index = 0; index < children.length; index += 1) {
      const rect = children[index].getBoundingClientRect();
      if (rect.width === 0) continue;
      if (rect.right > containerRight) {
        cutoff = index;
        break;
      }
    }

    setOverflowIndex(cutoff);
  };

  onMount(() => {
    requestAnimationFrame(checkOverflow);
    const observer = new ResizeObserver(() => requestAnimationFrame(checkOverflow));
    if (toolbarRef) observer.observe(toolbarRef);

    const handleClick = (event: MouseEvent) => {
      if (showHeadingMenu()) {
        const portal = document.getElementById("mz-heading-dropdown");
        if (
          headingBtnRef &&
          !headingBtnRef.contains(event.target as Node) &&
          (!portal || !portal.contains(event.target as Node))
        ) {
          setShowHeadingMenu(false);
        }
      }

      if (showOverflowMenu()) {
        const portal = document.getElementById("mz-overflow-dropdown");
        if (!portal || !portal.contains(event.target as Node)) {
          setShowOverflowMenu(false);
        }
      }
    };

    document.addEventListener("mousedown", handleClick);
    onCleanup(() => {
      observer.disconnect();
      document.removeEventListener("mousedown", handleClick);
    });
  });

  const overflowItems = () => {
    const cutoff = overflowIndex();
    if (cutoff < 0) return [];
    const flat = flatOtherItems();
    const start = cutoff - 3;
    return start < 0 ? flat : flat.slice(start);
  };

  const isItemVisible = (flatIndex: number) => {
    const cutoff = overflowIndex();
    if (cutoff < 0) return true;
    return flatIndex + 3 < cutoff;
  };

  const openHeadingMenu = () => {
    if (headingBtnRef) {
      const rect = headingBtnRef.getBoundingClientRect();
      setHeadingMenuPos({ x: rect.left, y: rect.bottom + 2 });
    }
    setShowHeadingMenu((value) => !value);
  };

  return (
    <div
      ref={toolbarRef}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{
        display: "flex",
        "align-items": "center",
        height: "var(--mz-toolbar-height)",
        "min-height": "var(--mz-toolbar-height)",
        padding: "0 var(--mz-space-2)",
        background: "var(--mz-bg-secondary)",
        "border-bottom": "1px solid var(--mz-border)",
        position: "relative",
        "z-index": "100",
        "flex-shrink": "0",
      }}
    >
      <div
        ref={itemsRef}
        style={{
          display: "flex",
          "align-items": "center",
          gap: "1px",
          flex: "1",
          "min-width": "0",
          overflow: "hidden",
        }}
      >
        <For each={otherItems().slice(0, 2)}>
          {(item, index) => (
            <span data-toolbar-idx={index()} style={{ display: "inline-flex", "align-items": "center" }}>
              <ToolbarBtn item={item} label={translateLabel(item)} onClick={() => dispatchCommand(item)} />
              <Show when={item.separator}>
                <ToolbarSep />
              </Show>
            </span>
          )}
        </For>

        <span data-toolbar-idx={2} style={{ display: "inline-flex", "align-items": "center" }}>
          <button
            ref={headingBtnRef}
            onClick={openHeadingMenu}
            title={t("toolbar.headingLevel")}
            style={headingButtonStyle}
            onMouseEnter={hoverToolbarButton}
            onMouseLeave={resetToolbarButton}
          >
            H
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M1.5 3L4 5.5L6.5 3" />
            </svg>
          </button>
          <ToolbarSep />
        </span>

        <For each={flatOtherItems()}>
          {(item, index) => (
            <span
              data-toolbar-idx={index() + 3}
              style={{
                display: isItemVisible(index()) ? "inline-flex" : "none",
                "align-items": "center",
              }}
            >
              <ToolbarBtn item={item} label={translateLabel(item)} onClick={() => dispatchCommand(item)} />
              <Show when={item.separator}>
                <ToolbarSep />
              </Show>
            </span>
          )}
        </For>
      </div>

      <div
        ref={rightAreaRef}
        style={{
          display: "flex",
          "align-items": "center",
          gap: "2px",
          "flex-shrink": "0",
          "margin-left": "4px",
        }}
      >
        <Show when={overflowIndex() >= 0}>
          <button
            onClick={(event) => {
              event.stopPropagation();
              setShowOverflowMenu((value) => !value);
            }}
            title={t("toolbar.moreTools")}
            style={iconButtonStyle}
            onMouseEnter={hoverToolbarButton}
            onMouseLeave={resetToolbarButton}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="3" cy="8" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="13" cy="8" r="1.5" />
            </svg>
          </button>
        </Show>

        <button
          onClick={cycleToolbarViewMode}
          title={t("toolbar.cycleViewMode")}
          style={{
            display: "flex",
            "align-items": "center",
            gap: "4px",
            padding: "4px 10px",
            border: "1px solid var(--mz-border)",
            background: "transparent",
            color: "var(--mz-text-secondary)",
            cursor: "pointer",
            "border-radius": "var(--mz-radius-md)",
            "font-size": "var(--mz-font-size-xs)",
            "font-family": "var(--mz-font-sans)",
            "font-weight": "500",
            "flex-shrink": "0",
          }}
          onMouseEnter={(event) => {
            event.currentTarget.style.borderColor = "var(--mz-accent)";
            event.currentTarget.style.color = "var(--mz-accent)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.borderColor = "var(--mz-border)";
            event.currentTarget.style.color = "var(--mz-text-secondary)";
          }}
        >
          {viewModeLabel()}
        </button>
      </div>

      <Show when={showHeadingMenu()}>
        <div
          id="mz-heading-dropdown"
          style={{
            position: "fixed",
            top: `${headingMenuPos().y}px`,
            left: `${headingMenuPos().x}px`,
            "min-width": "130px",
            background: "var(--mz-bg-secondary)",
            border: "1px solid var(--mz-border-strong)",
            "border-radius": "var(--mz-radius-md)",
            "box-shadow": "0 4px 16px rgba(0,0,0,0.25)",
            padding: "4px 0",
            "z-index": "10000",
          }}
          onMouseLeave={() => setShowHeadingMenu(false)}
        >
          <For each={headingItems()}>
            {(item) => (
              <button
                onClick={() => {
                  dispatchCommand(item);
                  setShowHeadingMenu(false);
                }}
                style={dropdownButtonStyle}
                onMouseEnter={hoverDropdownButton}
                onMouseLeave={resetDropdownButton}
              >
                <span>{translateLabel(item)}</span>
                <span style={shortcutStyle}>{item.shortcut}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={showOverflowMenu()}>
        <div
          id="mz-overflow-dropdown"
          style={{
            position: "fixed",
            top: `${(toolbarRef?.getBoundingClientRect().bottom ?? 40) + 2}px`,
            right: `${window.innerWidth - (rightAreaRef?.getBoundingClientRect().right ?? window.innerWidth)}px`,
            "min-width": "180px",
            background: "var(--mz-bg-secondary)",
            border: "1px solid var(--mz-border-strong)",
            "border-radius": "var(--mz-radius-md)",
            "box-shadow": "0 4px 16px rgba(0,0,0,0.3)",
            padding: "4px 0",
            "z-index": "10000",
          }}
          onMouseLeave={() => setShowOverflowMenu(false)}
        >
          <For each={overflowItems()}>
            {(item) => (
              <>
                <button
                  onClick={() => {
                    dispatchCommand(item);
                    setShowOverflowMenu(false);
                  }}
                  style={dropdownButtonStyle}
                  onMouseEnter={hoverDropdownButton}
                  onMouseLeave={resetDropdownButton}
                >
                  <span style={{ display: "flex", "align-items": "center", gap: "8px" }}>
                    <span style={{ "min-width": "20px", "text-align": "center" }}>
                      {item.icon}
                    </span>
                    {translateLabel(item)}
                  </span>
                  <Show when={item.shortcut}>
                    <span style={shortcutStyle}>{item.shortcut}</span>
                  </Show>
                </button>
                <Show when={item.separator}>
                  <div style={{ height: "1px", background: "var(--mz-border)", margin: "4px 8px" }} />
                </Show>
              </>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

const ToolbarBtn: Component<{
  item: ToolbarButton;
  label: string;
  onClick: () => void;
}> = (props) => (
  <button
    onClick={props.onClick}
    title={`${props.label}${props.item.shortcut ? ` (${props.item.shortcut})` : ""}`}
    style={{
      display: "flex",
      "align-items": "center",
      "justify-content": "center",
      "min-width": "28px",
      height: "28px",
      border: "none",
      background: "transparent",
      color: "var(--mz-text-secondary)",
      cursor: "pointer",
      "border-radius": "var(--mz-radius-sm)",
      "font-size": "13px",
      "font-weight": props.item.icon === "B" ? "700" : "400",
      "font-style": props.item.icon === "I" ? "italic" : "normal",
      "text-decoration":
        props.item.command === "underline"
          ? "underline"
          : props.item.command === "strikethrough"
            ? "line-through"
            : "none",
      padding: "0 4px",
      "font-family": "var(--mz-font-sans)",
      "flex-shrink": "0",
    }}
    onMouseEnter={hoverToolbarButton}
    onMouseLeave={resetToolbarButton}
  >
    {props.item.icon}
  </button>
);

const ToolbarSep: Component = () => (
  <div
    style={{
      width: "1px",
      height: "16px",
      background: "var(--mz-border)",
      margin: "0 3px",
      "flex-shrink": "0",
    }}
  />
);

const headingButtonStyle = {
  display: "flex",
  "align-items": "center",
  gap: "2px",
  "min-width": "28px",
  height: "28px",
  border: "none",
  background: "transparent",
  color: "var(--mz-text-secondary)",
  cursor: "pointer",
  "border-radius": "var(--mz-radius-sm)",
  "font-size": "13px",
  padding: "0 6px",
  "font-family": "var(--mz-font-sans)",
  "flex-shrink": "0",
} as const;

const iconButtonStyle = {
  display: "flex",
  "align-items": "center",
  "justify-content": "center",
  width: "28px",
  height: "28px",
  border: "none",
  background: "transparent",
  color: "var(--mz-text-secondary)",
  cursor: "pointer",
  "border-radius": "var(--mz-radius-sm)",
} as const;

const dropdownButtonStyle = {
  display: "flex",
  "align-items": "center",
  "justify-content": "space-between",
  width: "100%",
  padding: "6px 12px",
  border: "none",
  background: "transparent",
  color: "var(--mz-text-primary)",
  cursor: "pointer",
  "font-size": "var(--mz-font-size-sm)",
  "font-family": "var(--mz-font-sans)",
  "text-align": "left" as const,
} as const;

const shortcutStyle = {
  "font-size": "var(--mz-font-size-xs)",
  color: "var(--mz-text-muted)",
  "font-family": "var(--mz-font-mono)",
} as const;

function hoverToolbarButton(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement;
  target.style.background = "var(--mz-bg-hover)";
  target.style.color = "var(--mz-text-primary)";
}

function resetToolbarButton(event: MouseEvent) {
  const target = event.currentTarget as HTMLElement;
  target.style.background = "transparent";
  target.style.color = "var(--mz-text-secondary)";
}

function hoverDropdownButton(event: MouseEvent) {
  (event.currentTarget as HTMLElement).style.background = "var(--mz-bg-hover)";
}

function resetDropdownButton(event: MouseEvent) {
  (event.currentTarget as HTMLElement).style.background = "transparent";
}

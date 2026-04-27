import {
  Component,
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { t } from "../../i18n";

export interface MenuItem {
  label: string;
  icon?: string;
  action: () => void;
  danger?: boolean;
  separator?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export const ContextMenu: Component<ContextMenuProps> = (props) => {
  let menuRef: HTMLDivElement | undefined;
  const [menuSize, setMenuSize] = createSignal({ width: 180, height: 0 });

  createEffect(
    on(
      () => [props.x, props.y, props.items] as const,
      () => {
        const frame = requestAnimationFrame(() => {
          if (!menuRef) return;
          const rect = menuRef.getBoundingClientRect();
          setMenuSize({ width: rect.width, height: rect.height });
        });

        onCleanup(() => cancelAnimationFrame(frame));
      }
    )
  );

  onMount(() => {
    const handleClick = (event: MouseEvent) => {
      if (menuRef && !menuRef.contains(event.target as Node)) {
        props.onClose();
      }
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (menuRef && !menuRef.contains(event.target as Node)) {
        props.onClose();
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };

    setTimeout(() => {
      document.addEventListener("click", handleClick);
      document.addEventListener("contextmenu", handleContextMenu, true);
      document.addEventListener("keydown", handleEscape);
    }, 0);

    onCleanup(() => {
      document.removeEventListener("click", handleClick);
      document.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("keydown", handleEscape);
    });
  });

  const adjustedX = () => {
    const menuWidth = menuSize().width || 180;
    return props.x + menuWidth > window.innerWidth
      ? Math.max(8, window.innerWidth - menuWidth - 8)
      : props.x;
  };

  const adjustedY = () => {
    const menuHeight =
      menuSize().height ||
      Math.min(window.innerHeight - 16, props.items.length * 32 + 8);
    return props.y + menuHeight > window.innerHeight
      ? Math.max(8, window.innerHeight - menuHeight - 8)
      : props.y;
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: "0",
        "z-index": "10000",
        "pointer-events": "none",
      }}
    >
      <div
        ref={menuRef}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        style={{
          position: "absolute",
          left: `${adjustedX()}px`,
          top: `${adjustedY()}px`,
          "min-width": "170px",
          background: "var(--mz-bg-secondary)",
          border: "1px solid var(--mz-border-strong)",
          "border-radius": "var(--mz-radius-md)",
          "box-shadow": "0 8px 24px rgba(0, 0, 0, 0.25)",
          padding: "4px 0",
          "font-size": "var(--mz-font-size-sm)",
          "pointer-events": "auto",
          "max-height": "calc(100vh - 16px)",
          "overflow-y": "auto",
        }}
      >
        <For each={props.items}>
          {(item) => (
            <>
              <Show when={item.separator}>
                <div
                  style={{
                    height: "1px",
                    background: "var(--mz-border)",
                    margin: "4px 8px",
                  }}
                />
              </Show>
              <button
                onClick={() => {
                  props.onClose();
                  item.action();
                }}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  width: "100%",
                  padding: "6px 12px",
                  border: "none",
                  background: "transparent",
                  color: item.danger
                    ? "var(--mz-error)"
                    : "var(--mz-text-primary)",
                  cursor: "pointer",
                  "text-align": "left",
                  "font-size": "var(--mz-font-size-sm)",
                  "font-family": "var(--mz-font-sans)",
                }}
                onMouseEnter={(event) => {
                  event.currentTarget.style.background = item.danger
                    ? "rgba(224, 108, 117, 0.12)"
                    : "var(--mz-bg-hover)";
                }}
                onMouseLeave={(event) => {
                  event.currentTarget.style.background = "transparent";
                }}
              >
                <Show when={item.icon}>
                  <span style={{ width: "16px", "text-align": "center" }}>
                    {item.icon}
                  </span>
                </Show>
                {item.label}
              </button>
            </>
          )}
        </For>
      </div>
    </div>
  );
};

export interface FileContextMenuState {
  show: boolean;
  x: number;
  y: number;
  items: MenuItem[];
}

export function createFileContextMenu(callbacks: {
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onNewFile: (dirPath: string) => void;
  onNewFolder: (dirPath: string) => void;
  onCopyPath: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const [menu, setMenu] = createSignal<FileContextMenuState>({
    show: false,
    x: 0,
    y: 0,
    items: [],
  });

  function showForFile(event: MouseEvent, path: string, isDir: boolean) {
    event.preventDefault();
    event.stopPropagation();

    const dirPath = isDir ? path : path.split("/").slice(0, -1).join("/") || "";
    const items: MenuItem[] = [];

    if (!isDir) {
      items.push({
        label: t("context.open"),
        icon: "📄",
        action: () => callbacks.onOpenFile(path),
      });
    }

    items.push({
      label: t("context.newNote"),
      icon: "✏️",
      action: () => callbacks.onNewFile(dirPath),
    });
    items.push({
      label: t("context.newFolder"),
      icon: "📁",
      action: () => callbacks.onNewFolder(dirPath),
    });
    items.push({
      label: t("context.copyPath"),
      icon: "📋",
      action: () => callbacks.onCopyPath(path),
      separator: true,
    });
    items.push({
      label: t("context.rename"),
      icon: "✎",
      action: () => callbacks.onRename(path),
      separator: true,
    });
    items.push({
      label: t("context.delete"),
      icon: "🗑",
      action: () => callbacks.onDelete(path),
      danger: true,
    });

    setMenu({ show: true, x: event.clientX, y: event.clientY, items });
  }

  function close() {
    setMenu((current: FileContextMenuState) => ({ ...current, show: false }));
  }

  return { menu, showForFile, close };
}

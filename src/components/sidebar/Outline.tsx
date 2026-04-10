import {
  Component,
  For,
  Show,
  createEffect,
  createMemo,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { t } from "../../i18n";
import { editorStore } from "../../stores/editor";
import {
  getActivePluginView,
  hasPluginViewForExtension,
  pluginsVersion,
} from "../../stores/plugins";
import { vaultStore } from "../../stores/vault";

interface OutlineHeading {
  level: number;
  line: number;
  text: string;
}

function extractHeadings(source: string): OutlineHeading[] {
  const lines = source.split("\n");
  const result: OutlineHeading[] = [];
  let inFence = false;
  let fenceMarker = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1][0];
      } else if (line.startsWith(fenceMarker.repeat(3))) {
        inFence = false;
      }
      continue;
    }

    if (inFence) continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!headingMatch) continue;

    result.push({
      level: headingMatch[1].length,
      line: index + 1,
      text: headingMatch[2],
    });
  }

  return result;
}

function activeHeadingIndex(headings: OutlineHeading[], cursorLine: number) {
  let active = -1;
  for (let index = 0; index < headings.length; index += 1) {
    if (headings[index].line <= cursorLine) active = index;
    else break;
  }
  return active;
}

const MarkdownOutline: Component = () => {
  let listRef: HTMLDivElement | undefined;

  const headings = createMemo(() => {
    const activeFile = vaultStore.activeFile();
    if (!activeFile) return [];
    return extractHeadings(activeFile.content);
  });

  const activeIndex = createMemo(() =>
    activeHeadingIndex(headings(), editorStore.cursorLine()),
  );

  const jumpToHeading = (heading: OutlineHeading) => {
    document.dispatchEvent(
      new CustomEvent("mindzj:editor-command", {
        detail: { command: "goto-line", line: heading.line - 1 },
      }),
    );
  };

  createEffect(
    on(activeIndex, (index) => {
      if (index < 0 || !listRef) return;
      const row = listRef.querySelector(
        `[data-outline-idx="${index}"]`,
      ) as HTMLElement | null;
      row?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }),
  );

  return (
    <div
      ref={listRef}
      style={{
        flex: "1",
        "min-height": "0",
        overflow: "auto",
        padding: "4px 0",
        "font-size": "var(--mz-font-size-sm)",
      }}
    >
      <Show
        when={headings().length > 0}
        fallback={
          <div
            style={{
              padding: "16px",
              "text-align": "center",
              color: "var(--mz-text-muted)",
              "font-size": "var(--mz-font-size-xs)",
            }}
          >
            {t("outline.empty")}
          </div>
        }
      >
        <For each={headings()}>
          {(heading, index) => {
            const isActive = () => activeIndex() === index();

            return (
              <div
                data-outline-idx={index()}
                onClick={() => jumpToHeading(heading)}
                title={t("outline.headingTitle", {
                  level: heading.level,
                  line: heading.line,
                })}
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "6px",
                  padding: `3px 10px 3px ${8 + (heading.level - 1) * 14}px`,
                  cursor: "pointer",
                  color: isActive()
                    ? "var(--mz-accent)"
                    : "var(--mz-text-secondary)",
                  background: isActive()
                    ? "var(--mz-accent-subtle)"
                    : "transparent",
                  "border-left": isActive()
                    ? "2px solid var(--mz-accent)"
                    : "2px solid transparent",
                  "font-weight": isActive() ? "600" : "400",
                  "font-size":
                    heading.level <= 2
                      ? "var(--mz-font-size-sm)"
                      : "var(--mz-font-size-xs)",
                  "white-space": "nowrap",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                }}
                onMouseEnter={(event) => {
                  if (!isActive()) {
                    event.currentTarget.style.background = "var(--mz-bg-hover)";
                  }
                }}
                onMouseLeave={(event) => {
                  if (!isActive()) {
                    event.currentTarget.style.background = "transparent";
                  }
                }}
              >
                <span style={{ overflow: "hidden", "text-overflow": "ellipsis" }}>
                  {heading.text}
                </span>
              </div>
            );
          }}
        </For>
      </Show>
    </div>
  );
};

export const Outline: Component = () => {
  let pluginOutlineRef: HTMLDivElement | undefined;
  let mountedOutlineView: any = null;
  let currentOutlineApp: any = null;

  const isPluginFile = () => {
    const file = vaultStore.activeFile();
    if (!file) return false;
    const extension = file.path.split(".").pop()?.toLowerCase() ?? "";
    pluginsVersion();
    return hasPluginViewForExtension(extension);
  };

  const isMarkdownFile = () => {
    const file = vaultStore.activeFile();
    if (!file) return false;
    return file.path.split(".").pop()?.toLowerCase() === "md";
  };

  function findOutlinePlugin() {
    const file = vaultStore.activeFile();
    if (!file) return null;

    if (isPluginFile()) {
      const view = getActivePluginView(file.path);
      if (view?.plugin?._outlineViewCreator) {
        return { plugin: view.plugin, app: view.app, view };
      }
    }

    const loadedPlugins = (window as any).__mindzj_loadedPlugins;
    if (loadedPlugins) {
      for (const plugin of loadedPlugins) {
        if (plugin.instance?._outlineViewCreator) {
          return { plugin: plugin.instance, app: plugin.instance.app, view: null };
        }
      }
    }

    return null;
  }

  function mountOutline() {
    if (mountedOutlineView) {
      try {
        mountedOutlineView.onClose?.();
      } catch {}
      mountedOutlineView = null;
      currentOutlineApp = null;
    }

    if (pluginOutlineRef) pluginOutlineRef.innerHTML = "";

    const file = vaultStore.activeFile();
    if (!file || !pluginOutlineRef) return;

    const info = findOutlinePlugin();
    if (!info?.plugin?._outlineViewCreator) return;

    const { plugin, app, view } = info;

    if (app?.workspace) {
      if (view) {
        app.workspace.activeLeaf = view.leaf || { view, app };
      } else {
        const fileName = file.path.split("/").pop() ?? file.path;
        const fakeFile = {
          path: file.path,
          name: fileName,
          basename: fileName.replace(/\.[^.]+$/, ""),
          extension: "md",
        };

        const fakeMarkdownView: any = {
          file: fakeFile,
          getViewType: () => "markdown",
          setEphemeralState: (state: any) => {
            if (state?.line !== undefined) {
              document.dispatchEvent(
                new CustomEvent("mindzj:editor-command", {
                  detail: { command: "goto-line", line: state.line },
                }),
              );
            }
          },
        };

        app.workspace.activeLeaf = { view: fakeMarkdownView, app };
      }
    }

    try {
      const outlineLeaf: any = {
        app,
        view: null,
        containerEl: null,
        getViewState: () => ({ type: "mindzj-outline", state: {} }),
        setViewState: async () => {},
        detach: () => {},
      };

      const outlineView = plugin._outlineViewCreator(outlineLeaf);
      outlineLeaf.view = outlineView;
      outlineLeaf.containerEl = outlineView.containerEl;

      Object.assign(outlineView.containerEl.style, {
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      });

      const viewContent = outlineView.containerEl.children?.[1] as HTMLElement;
      if (viewContent) {
        Object.assign(viewContent.style, {
          flex: "1",
          overflow: "auto",
          minHeight: "0",
        });
      }

      pluginOutlineRef.appendChild(outlineView.containerEl);
      outlineView.onOpen?.();

      const originalRefresh = outlineView.refresh?.bind(outlineView);
      outlineView.refresh = () => {
        const activeLeaf = app?.workspace?.activeLeaf;
        if (
          activeLeaf?.view?.getViewType?.() === "markdown" &&
          outlineView.refreshMarkdown
        ) {
          if (outlineView.treeEl) outlineView.treeEl.innerHTML = "";
          else if (originalRefresh) {
            originalRefresh();
            return;
          }
          outlineView.refreshMarkdown(activeLeaf.view);
        } else {
          originalRefresh?.();
        }
      };

      outlineView.refresh();
      mountedOutlineView = outlineView;
      currentOutlineApp = app;

      if (app?.workspace) {
        app.workspace._outlineLeaves = [outlineLeaf];
      }
    } catch (error) {
      console.warn("[Outline] Failed to mount plugin outline:", error);
    }
  }

  createEffect(
    on(
      () => ({ path: vaultStore.activeFile()?.path, plugins: pluginsVersion() }),
      () => mountOutline(),
    ),
  );

  onMount(() => {
    const handler = () => {
      if (!mountedOutlineView?.refresh) return;

      const file = vaultStore.activeFile();
      if (file && currentOutlineApp?.workspace && isPluginFile()) {
        const view = getActivePluginView(file.path);
        if (view) {
          currentOutlineApp.workspace.activeLeaf = view.leaf || {
            view,
            app: currentOutlineApp,
          };
        }
      }

      mountedOutlineView.refresh();
    };

    document.addEventListener("mindzj:outline-refresh", handler);
    onCleanup(() =>
      document.removeEventListener("mindzj:outline-refresh", handler),
    );
  });

  onCleanup(() => {
    if (!mountedOutlineView) return;
    try {
      mountedOutlineView.onClose?.();
    } catch {}
    mountedOutlineView = null;
  });

  return (
    <div
      style={{
        flex: "1",
        "min-height": "0",
        display: "flex",
        "flex-direction": "column",
        overflow: "hidden",
      }}
    >
      <Show
        when={isMarkdownFile()}
        fallback={<div ref={pluginOutlineRef} style={{ flex: "1", overflow: "auto" }} />}
      >
        <MarkdownOutline />
      </Show>
    </div>
  );
};

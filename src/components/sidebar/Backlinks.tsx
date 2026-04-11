import { Component, For, Show, createMemo, createResource } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { vaultStore } from "../../stores/vault";
import { displayName } from "../../utils/displayName";
import { openFileRouted } from "../../utils/openFileRouted";
import { t } from "../../i18n";

interface NoteLink {
    source: string;
    target: string;
    display_text: string | null;
    link_type: string;
    line: number;
    column: number;
}

export const Backlinks: Component = () => {
    const activePath = createMemo(() => vaultStore.activeFile()?.path ?? null);

    const [backlinks] = createResource(activePath, async (path) => {
        if (!path) return [];
        try {
            return await invoke<NoteLink[]>("get_backlinks", {
                relativePath: path,
            });
        } catch {
            return [];
        }
    });

    const [forwardLinks] = createResource(activePath, async (path) => {
        if (!path) return [];
        try {
            return await invoke<NoteLink[]>("get_forward_links", {
                relativePath: path,
            });
        } catch {
            return [];
        }
    });

    // Use the shared displayName helper so stripping rules stay consistent
    // with the rest of the UI.
    const fileName = (path: string) => displayName(path);

    return (
        <div style={{ padding: "8px 0" }}>
            {/* Backlinks section */}
            <div
                style={{
                    padding: "4px 12px",
                    "font-size": "var(--mz-font-size-xs)",
                    "font-weight": "600",
                    color: "var(--mz-text-muted)",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.5px",
                }}>
                {t("links.backlinks")}
            </div>

            <Show
                when={!backlinks.loading && (backlinks() ?? []).length > 0}
                fallback={
                    <div
                        style={{
                            padding: "8px 12px",
                            "font-size": "var(--mz-font-size-xs)",
                            color: "var(--mz-text-muted)",
                        }}>
                        {backlinks.loading ? t("common.loading") : t("links.noBacklinks")}
                    </div>
                }>
                <For each={backlinks()}>
                    {(link) => (
                        <div
                            onClick={() => void openFileRouted(link.source)}
                            style={{
                                padding: "3px 12px",
                                "font-size": "var(--mz-font-size-sm)",
                                color: "var(--mz-accent)",
                                cursor: "pointer",
                                "border-radius": "var(--mz-radius-sm)",
                                margin: "0 4px",
                                transition: "background 100ms",
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background =
                                    "var(--mz-bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background =
                                    "transparent";
                            }}>
                            ← {fileName(link.source)}
                            <span
                                style={{
                                    color: "var(--mz-text-muted)",
                                    "font-size": "var(--mz-font-size-xs)",
                                    "margin-left": "4px",
                                }}>
                                L{link.line + 1}
                            </span>
                        </div>
                    )}
                </For>
            </Show>

            {/* Forward links section */}
            <div
                style={{
                    padding: "4px 12px",
                    "margin-top": "12px",
                    "font-size": "var(--mz-font-size-xs)",
                    "font-weight": "600",
                    color: "var(--mz-text-muted)",
                    "text-transform": "uppercase",
                    "letter-spacing": "0.5px",
                }}>
                {t("links.forwardLinks")}
            </div>

            <Show
                when={
                    !forwardLinks.loading && (forwardLinks() ?? []).length > 0
                }
                fallback={
                    <div
                        style={{
                            padding: "8px 12px",
                            "font-size": "var(--mz-font-size-xs)",
                            color: "var(--mz-text-muted)",
                        }}>
                        {forwardLinks.loading ? t("common.loading") : t("links.noForwardLinks")}
                    </div>
                }>
                <For each={forwardLinks()}>
                    {(link) => (
                        <div
                            onClick={() => void openFileRouted(link.target)}
                            style={{
                                padding: "3px 12px",
                                "font-size": "var(--mz-font-size-sm)",
                                color: "var(--mz-accent)",
                                cursor: "pointer",
                                "border-radius": "var(--mz-radius-sm)",
                                margin: "0 4px",
                                transition: "background 100ms",
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.background =
                                    "var(--mz-bg-hover)";
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.background =
                                    "transparent";
                            }}>
                            → {fileName(link.target)}
                            <Show when={link.display_text}>
                                <span
                                    style={{
                                        color: "var(--mz-text-muted)",
                                        "font-size": "var(--mz-font-size-xs)",
                                        "margin-left": "4px",
                                    }}>
                                    ({link.display_text})
                                </span>
                            </Show>
                        </div>
                    )}
                </For>
            </Show>
        </div>
    );
};

import { Component, Show, createEffect, createMemo } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { editorStore } from "../../stores/editor";
import { vaultStore } from "../../stores/vault";
import { displayName } from "../../utils/displayName";
import { getFileExtension } from "../../utils/fileTypes";
import { toVaultAssetUrl } from "../../utils/vaultPaths";
import { t } from "../../i18n";

export const FilePreview: Component<{
    filePath: string;
    kind: "image" | "document";
    active?: boolean;
}> = (props) => {
    const fileName = createMemo(() => displayName(props.filePath));
    const extension = createMemo(() => getFileExtension(props.filePath).toUpperCase() || "FILE");
    const assetUrl = createMemo(() => {
        const root = vaultStore.vaultInfo()?.path ?? "";
        if (!root) return "";
        try {
            return toVaultAssetUrl(root, props.filePath);
        } catch (error) {
            console.warn("[FilePreview] failed to build asset URL:", error);
            return "";
        }
    });

    const openInDefaultApp = async () => {
        try {
            await invoke("open_in_default_app", { relativePath: props.filePath });
        } catch (error) {
            console.warn("[FilePreview] open_in_default_app failed:", error);
        }
    };

    const revealInExplorer = async () => {
        try {
            await invoke("reveal_in_file_manager", { relativePath: props.filePath });
        } catch (error) {
            console.warn("[FilePreview] reveal_in_file_manager failed:", error);
        }
    };

    createEffect(() => {
        if (!props.active) return;
        editorStore.updateStats("");
        editorStore.setCursorLine(1);
        editorStore.setCursorCol(1);
    });

    return (
        <div
            style={{
                flex: "1",
                display: "flex",
                "flex-direction": "column",
                "min-width": "0",
                "min-height": "0",
                overflow: "hidden",
                background: "var(--mz-bg-primary)",
            }}
        >
            <Show
                when={props.kind === "image"}
                fallback={
                    <div
                        style={{
                            flex: "1",
                            display: "flex",
                            "align-items": "center",
                            "justify-content": "center",
                            padding: "32px",
                        }}
                    >
                        <div
                            style={{
                                width: "min(460px, 100%)",
                                display: "flex",
                                "flex-direction": "column",
                                gap: "16px",
                                padding: "28px",
                                border: "1px solid var(--mz-border)",
                                "border-radius": "16px",
                                background: "var(--mz-bg-secondary)",
                                "box-shadow": props.active
                                    ? "0 0 0 1px color-mix(in srgb, var(--mz-accent) 40%, transparent)"
                                    : "none",
                            }}
                        >
                            <div
                                style={{
                                    display: "flex",
                                    "align-items": "center",
                                    gap: "14px",
                                }}
                            >
                                <div
                                    style={{
                                        width: "52px",
                                        height: "52px",
                                        "border-radius": "14px",
                                        background: "var(--mz-bg-tertiary)",
                                        border: "1px solid var(--mz-border)",
                                        display: "flex",
                                        "align-items": "center",
                                        "justify-content": "center",
                                        color: "var(--mz-text-secondary)",
                                        "font-size": "13px",
                                        "font-weight": "700",
                                        "letter-spacing": "0.06em",
                                        "flex-shrink": "0",
                                    }}
                                >
                                    {extension()}
                                </div>
                                <div style={{ "min-width": "0" }}>
                                    <div
                                        style={{
                                            "font-size": "var(--mz-font-size-md)",
                                            "font-weight": "600",
                                            color: "var(--mz-text-primary)",
                                            overflow: "hidden",
                                            "text-overflow": "ellipsis",
                                            "white-space": "nowrap",
                                        }}
                                    >
                                        {fileName()}
                                    </div>
                                    <div
                                        style={{
                                            "font-size": "var(--mz-font-size-sm)",
                                            color: "var(--mz-text-muted)",
                                            "margin-top": "4px",
                                        }}
                                    >
                                        {t("filePreview.documentDescription")}
                                    </div>
                                </div>
                            </div>
                            <div style={{ display: "flex", gap: "10px", "flex-wrap": "wrap" }}>
                                <button onClick={() => void openInDefaultApp()} style={actionButtonStyle(true)}>
                                    {t("livePreview.openInDefaultApp")}
                                </button>
                                <button onClick={() => void revealInExplorer()} style={actionButtonStyle(false)}>
                                    {t("context.showInExplorer")}
                                </button>
                            </div>
                        </div>
                    </div>
                }
            >
                <div
                    style={{
                        flex: "1",
                        display: "flex",
                        "align-items": "center",
                        "justify-content": "center",
                        padding: "20px",
                        overflow: "auto",
                        background:
                            "radial-gradient(circle at center, color-mix(in srgb, var(--mz-accent) 10%, transparent) 0%, transparent 55%)",
                    }}
                >
                    <img
                        src={assetUrl()}
                        alt={fileName()}
                        draggable={false}
                        style={{
                            display: "block",
                            "max-width": "100%",
                            "max-height": "100%",
                            width: "auto",
                            height: "auto",
                            "object-fit": "contain",
                            "border-radius": "10px",
                            "box-shadow": "0 12px 40px rgba(0,0,0,0.22)",
                            background: "transparent",
                        }}
                    />
                </div>
            </Show>
        </div>
    );
};

function actionButtonStyle(primary: boolean) {
    return {
        height: "34px",
        padding: "0 14px",
        border: primary ? "1px solid var(--mz-accent)" : "1px solid var(--mz-border)",
        background: primary ? "var(--mz-accent)" : "transparent",
        color: primary ? "var(--mz-text-on-accent)" : "var(--mz-text-secondary)",
        cursor: "pointer",
        "border-radius": "10px",
        "font-size": "var(--mz-font-size-sm)",
        "font-family": "var(--mz-font-sans)",
    } as const;
}

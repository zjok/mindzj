import {
    Component,
    createSignal,
    createMemo,
    onMount,
    onCleanup,
} from "solid-js";
import { toVaultAssetUrl } from "../../utils/vaultPaths";
import { WindowControls } from "./TitleBar";

/**
 * Standalone image viewer mounted when the window URL carries
 * `?image_viewer=1`. This is a dedicated Tauri window created by the
 * Rust `open_image_in_new_window` command. The file path is passed
 * via URL params (`vault_path`, `file_path`) — we don't open a full
 * vault context here, we just resolve the asset URL and render it.
 *
 * Features:
 *   - Click and drag to pan
 *   - Ctrl + mouse wheel to zoom (around cursor)
 *   - +/- keys for zoom
 *   - 0 key to reset
 *   - F key or double-click to fit to window
 *   - Arrow keys pan when zoomed in
 *   - Custom dark title bar so the window matches the rest of the app
 */
export const ImageViewer: Component<{
    vaultPath: string;
    filePath: string;
}> = (props) => {
    const [scale, setScale] = createSignal(1);
    const [offsetX, setOffsetX] = createSignal(0);
    const [offsetY, setOffsetY] = createSignal(0);
    const [naturalSize, setNaturalSize] = createSignal<{ w: number; h: number } | null>(null);
    const [loaded, setLoaded] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);

    const fileName = createMemo(() => {
        const parts = props.filePath.split(/[/\\]/);
        return parts[parts.length - 1] || props.filePath;
    });

    const assetUrl = createMemo(() => {
        try {
            return toVaultAssetUrl(props.vaultPath, props.filePath);
        } catch (e) {
            console.error("[ImageViewer] failed to resolve asset URL:", e);
            return "";
        }
    });

    let imgRef: HTMLImageElement | undefined;
    let canvasRef: HTMLDivElement | undefined;

    const fitToWindow = () => {
        const size = naturalSize();
        if (!size || !canvasRef) return;
        const rect = canvasRef.getBoundingClientRect();
        const margin = 32;
        const availW = Math.max(1, rect.width - margin);
        const availH = Math.max(1, rect.height - margin);
        const scaleX = availW / size.w;
        const scaleY = availH / size.h;
        setScale(Math.min(1, Math.min(scaleX, scaleY)));
        setOffsetX(0);
        setOffsetY(0);
    };

    const handleImageLoad = () => {
        if (!imgRef) return;
        setNaturalSize({ w: imgRef.naturalWidth, h: imgRef.naturalHeight });
        setLoaded(true);
        // Fit on the next frame so the canvas has its real size.
        requestAnimationFrame(() => fitToWindow());
        // Update window title to include dimensions
        document.title = `${fileName()} — ${imgRef.naturalWidth}×${imgRef.naturalHeight}`;
    };

    const handleImageError = () => {
        setError("Failed to load image");
        console.error("[ImageViewer] image failed to load:", assetUrl());
    };

    // --- Pan (drag to move) ------------------------------------------
    let dragStart: { x: number; y: number; ox: number; oy: number } | null = null;

    const onMouseDown = (e: MouseEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        dragStart = {
            x: e.clientX,
            y: e.clientY,
            ox: offsetX(),
            oy: offsetY(),
        };
    };

    const onMouseMove = (e: MouseEvent) => {
        if (!dragStart) return;
        setOffsetX(dragStart.ox + (e.clientX - dragStart.x));
        setOffsetY(dragStart.oy + (e.clientY - dragStart.y));
    };

    const onMouseUp = () => {
        dragStart = null;
    };

    // --- Zoom (Ctrl + wheel, cursor-anchored) ------------------------
    const onWheel = (e: WheelEvent) => {
        if (!canvasRef) return;
        e.preventDefault();
        const rect = canvasRef.getBoundingClientRect();
        const cx = e.clientX - rect.left - rect.width / 2;
        const cy = e.clientY - rect.top - rect.height / 2;
        const currentScale = scale();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        const nextScale = Math.max(0.05, Math.min(20, currentScale * factor));
        // Keep the point under the cursor stationary.
        const dx = (cx - offsetX()) * (nextScale / currentScale - 1);
        const dy = (cy - offsetY()) * (nextScale / currentScale - 1);
        setScale(nextScale);
        setOffsetX(offsetX() - dx);
        setOffsetY(offsetY() - dy);
    };

    // --- Keyboard shortcuts ------------------------------------------
    const onKeyDown = (e: KeyboardEvent) => {
        switch (e.key) {
            case "+":
            case "=":
                setScale((s) => Math.min(20, s * 1.1));
                break;
            case "-":
            case "_":
                setScale((s) => Math.max(0.05, s / 1.1));
                break;
            case "0":
                setScale(1);
                setOffsetX(0);
                setOffsetY(0);
                break;
            case "f":
            case "F":
                fitToWindow();
                break;
            case "ArrowLeft":
                setOffsetX((x) => x + 40);
                break;
            case "ArrowRight":
                setOffsetX((x) => x - 40);
                break;
            case "ArrowUp":
                setOffsetY((y) => y + 40);
                break;
            case "ArrowDown":
                setOffsetY((y) => y - 40);
                break;
            case "Escape":
                // Close window on escape
                import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
                    void getCurrentWindow().close();
                });
                break;
        }
    };

    onMount(() => {
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        document.addEventListener("keydown", onKeyDown);
        document.title = fileName();
    });

    onCleanup(() => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("keydown", onKeyDown);
    });

    return (
        <div
            style={{
                display: "flex",
                "flex-direction": "column",
                position: "fixed",
                inset: "0",
                background: "var(--mz-bg-primary)",
                "font-family": "var(--mz-font-sans)",
                color: "var(--mz-text-primary)",
                overflow: "hidden",
            }}
        >
            {/* Custom titlebar — drag region + filename + window controls */}
            <div
                data-tauri-drag-region
                style={{
                    display: "flex",
                    "align-items": "center",
                    height: "var(--mz-tab-height)",
                    "flex-shrink": "0",
                    background: "var(--mz-bg-secondary)",
                    "border-bottom": "1px solid var(--mz-border)",
                    "-webkit-app-region": "drag",
                    "user-select": "none",
                    padding: "0 12px",
                    gap: "12px",
                }}
            >
                <span
                    style={{
                        flex: "1",
                        "min-width": "0",
                        overflow: "hidden",
                        "text-overflow": "ellipsis",
                        "white-space": "nowrap",
                        "font-size": "var(--mz-font-size-sm)",
                        color: "var(--mz-text-secondary)",
                    }}
                >
                    {fileName()}
                </span>
                <span
                    style={{
                        "font-size": "var(--mz-font-size-xs)",
                        color: "var(--mz-text-muted)",
                        "font-variant-numeric": "tabular-nums",
                        "flex-shrink": "0",
                    }}
                >
                    {Math.round(scale() * 100)}%
                </span>
                <div style={{ "-webkit-app-region": "no-drag", "flex-shrink": "0" }}>
                    <WindowControls />
                </div>
            </div>

            {/* Viewer canvas — drag to pan, Ctrl+wheel to zoom */}
            <div
                ref={canvasRef}
                onMouseDown={onMouseDown}
                onWheel={onWheel}
                onDblClick={fitToWindow}
                style={{
                    flex: "1",
                    "min-height": "0",
                    position: "relative",
                    overflow: "hidden",
                    cursor: dragStart ? "grabbing" : "grab",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                }}
            >
                {error() ? (
                    <div
                        style={{
                            color: "var(--mz-error)",
                            "font-size": "var(--mz-font-size-sm)",
                        }}
                    >
                        {error()}: {fileName()}
                    </div>
                ) : (
                    <img
                        ref={imgRef}
                        src={assetUrl()}
                        alt={fileName()}
                        draggable={false}
                        onLoad={handleImageLoad}
                        onError={handleImageError}
                        style={{
                            "max-width": "none",
                            "max-height": "none",
                            transform: `translate(${offsetX()}px, ${offsetY()}px) scale(${scale()})`,
                            "transform-origin": "center center",
                            "image-rendering": scale() >= 4 ? "pixelated" : "auto",
                            opacity: loaded() ? "1" : "0",
                            transition: "opacity 120ms ease",
                            "pointer-events": "none",
                            "user-select": "none",
                        }}
                    />
                )}
            </div>

            {/* Help bar at bottom */}
            <div
                style={{
                    "flex-shrink": "0",
                    height: "24px",
                    background: "var(--mz-bg-secondary)",
                    "border-top": "1px solid var(--mz-border)",
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    gap: "16px",
                    "font-size": "11px",
                    color: "var(--mz-text-muted)",
                    "user-select": "none",
                }}
            >
                <span>Ctrl+Wheel: zoom</span>
                <span>Drag: pan</span>
                <span>F / Double-click: fit</span>
                <span>0: reset</span>
                <span>Esc: close</span>
            </div>
        </div>
    );
};

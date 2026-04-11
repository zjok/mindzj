import { invoke } from "@tauri-apps/api/core";
import { vaultStore } from "../stores/vault";
import { hasPluginViewForExtension } from "../stores/plugins";
import { getFileHandler } from "./fileTypes";

/**
 * Unified "open a file in the vault" entry point used by every
 * user-facing click site in the app (file tree, search results,
 * wikilink clicks, backlinks panel, command palette, calendar daily
 * note, etc.).
 *
 * Routes the file based on its extension:
 *
 *   - Text / markdown / source code → in-app CodeMirror editor via
 *     `vaultStore.openFile(path)`. The editor can handle any text
 *     encoding that `read_file` returns.
 *
 *   - Plugin-registered extensions (e.g. `.mindzj`) → also through
 *     `vaultStore.openFile(path)`, because the editor area delegates
 *     to a `PluginViewHost` when it detects a registered extension.
 *
 *   - Images (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`, ...) → a new
 *     dedicated Tauri webview window with the ImageViewer component.
 *     Reading an image via `read_file` would return garbled bytes,
 *     so routing to a separate window that uses the asset protocol
 *     is the only correct approach.
 *
 *   - Office documents, PDFs, archives, A/V files → the OS default
 *     application (Word, Excel, Acrobat, the system media player).
 *     We can't render these inside WebView2 usefully.
 *
 * Errors are logged but NOT thrown, so a single broken file click
 * never crashes the UI — each click site can `void openFileRouted(...)`.
 */
export async function openFileRouted(relativePath: string): Promise<void> {
    const handler = getFileHandler(relativePath, hasPluginViewForExtension);

    switch (handler) {
        case "image": {
            const info = vaultStore.vaultInfo();
            if (!info) return;
            try {
                await invoke("open_image_in_new_window", {
                    vaultPath: info.path,
                    vaultName: info.name,
                    filePath: relativePath,
                });
            } catch (e) {
                console.error("[openFileRouted] open_image_in_new_window failed:", e);
            }
            return;
        }

        case "external": {
            // Delegate to the OS default app: Word/Writer for .doc,
            // Excel/Calc for .xlsx/.csv, Acrobat/Preview for .pdf,
            // system media player for .mp4/.mp3, etc. The Rust
            // `open_in_default_app` command does `cmd /C start "" …`
            // on Windows, `open` on macOS, `xdg-open` on Linux.
            try {
                await invoke("open_in_default_app", { relativePath });
            } catch (e) {
                console.error("[openFileRouted] open_in_default_app failed:", e);
            }
            return;
        }

        case "editor":
        case "plugin":
        case "unknown":
        default: {
            // In-app editor or plugin view — the existing flow.
            // `unknown` falls through to the editor because most
            // unknown extensions are still text files of some kind
            // (readme, config, script), and showing garbled bytes
            // is strictly better than silently swallowing the click.
            try {
                await vaultStore.openFile(relativePath);
            } catch (e) {
                console.error("[openFileRouted] openFile failed:", e);
            }
            return;
        }
    }
}

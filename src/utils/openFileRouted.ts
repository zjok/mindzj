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
 *   - Images (`.png`, `.jpg`, `.gif`, `.webp`, `.svg`, ...) → an
 *     in-app preview tab.
 *
 *   - `.doc/.docx` → an in-app document placeholder tab so the file
 *     stays in the workspace rather than jumping out to another app.
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
            try {
                vaultStore.openPreviewFile(relativePath, "image");
            } catch (e) {
                console.error("[openFileRouted] openPreviewFile(image) failed:", e);
            }
            return;
        }

        case "preview": {
            try {
                vaultStore.openPreviewFile(relativePath, "document");
            } catch (e) {
                console.error("[openFileRouted] openPreviewFile(document) failed:", e);
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

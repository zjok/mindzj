/**
 * File-type → handler routing.
 *
 * When the user clicks a file in the tree (or opens one via wikilink,
 * search, command palette etc.) we need to decide HOW to render it:
 *
 *   - Markdown and plain-text files go into the CodeMirror editor.
 *   - `.mindzj` (or any plugin-registered extension) goes into a
 *     plugin view.
 *   - Images open in a dedicated image-viewer window (new Tauri
 *     webview) so the user can zoom/pan without cluttering the main
 *     editor area.
 *   - Office documents, PDFs, archives, A/V files etc. can't be
 *     rendered inside a WebView2 view in any useful way — we delegate
 *     them to the operating system's default app (Word, Excel,
 *     Acrobat, the default image/video player, etc.).
 */

export type FileHandler =
    /** Open in the built-in CodeMirror editor as text. */
    | "editor"
    /** Open via a registered plugin view (e.g. `.mindzj` → mind-map). */
    | "plugin"
    /** Open in a dedicated Tauri image-viewer window. */
    | "image"
    /** Delegate to the OS default application (Word, Excel, etc.). */
    | "external"
    /** Unknown extension — fall back to the editor (maybe it's text). */
    | "unknown";

const IMAGE_EXTS = new Set([
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "ico",
    // svg is BOTH an image AND a text file. We treat it as an image
    // here so clicking it in the file tree opens the rendered image.
    // Power users who want to edit the SVG source can still use the
    // OS's "Open with Notepad" from outside the app.
    "svg",
]);

/**
 * Extensions we open in the in-app CodeMirror editor.
 *
 * CodeMirror 6 is happy to render arbitrary text with line numbers,
 * syntax highlighting (via markdown lang) etc., so even files like
 * `.py` / `.rs` / `.ts` that we don't natively syntax-highlight still
 * become readable/editable.
 */
const TEXT_EXTS = new Set([
    // Markdown variants
    "md",
    "markdown",
    "mdx",
    // Plain text / logs
    "txt",
    "log",
    "readme",
    // Structured configs
    "json",
    "jsonc",
    "json5",
    "yaml",
    "yml",
    "toml",
    "ini",
    "conf",
    "cfg",
    "env",
    "xml",
    // Source code (readable in editor even if we don't highlight yet)
    "js",
    "mjs",
    "cjs",
    "ts",
    "tsx",
    "jsx",
    "py",
    "rs",
    "go",
    "java",
    "c",
    "cpp",
    "cc",
    "h",
    "hpp",
    "rb",
    "php",
    "lua",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "bat",
    "cmd",
    // Web
    "css",
    "scss",
    "sass",
    "less",
    "html",
    "htm",
    // SQL / misc text
    "sql",
    "graphql",
    "gql",
]);

/**
 * Files we hand off to the OS default app. These either can't render
 * in a WebView2 view at all (Office, PDF, archives) or would render
 * worse than the dedicated native app (A/V files).
 */
const EXTERNAL_EXTS = new Set([
    // Microsoft Office
    "doc",
    "docx",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    // OpenDocument
    "odt",
    "ods",
    "odp",
    // Apple iWork
    "pages",
    "numbers",
    "key",
    // Tabular (render better in Excel / Numbers than our editor)
    "csv",
    "tsv",
    // PDFs
    "pdf",
    // Audio / video
    "mp3",
    "m4a",
    "wav",
    "ogg",
    "flac",
    "aac",
    "mp4",
    "m4v",
    "mov",
    "avi",
    "mkv",
    "webm",
    "wmv",
    // Archives
    "zip",
    "rar",
    "7z",
    "tar",
    "gz",
    "bz2",
    "xz",
    // Executables / installers
    "exe",
    "msi",
    "dmg",
    "deb",
    "rpm",
    "app",
    "apk",
]);

export function getFileExtension(path: string): string {
    // Use lastIndexOf rather than split(".").pop() so that dot-files
    // like `.gitignore` (no extension) return "" instead of
    // "gitignore".
    const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const fileName = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const dot = fileName.lastIndexOf(".");
    if (dot <= 0) return "";
    return fileName.slice(dot + 1).toLowerCase();
}

export function getFileHandler(
    path: string,
    hasPluginView: (ext: string) => boolean,
): FileHandler {
    const ext = getFileExtension(path);
    // Plugin views take priority — any plugin-registered extension
    // (e.g. `.mindzj`) routes to the plugin, even if it would
    // otherwise match one of the built-in categories.
    if (ext && hasPluginView(ext)) return "plugin";
    if (IMAGE_EXTS.has(ext)) return "image";
    if (TEXT_EXTS.has(ext)) return "editor";
    if (EXTERNAL_EXTS.has(ext)) return "external";
    // Unknown extension: try the editor. Worst case the user sees
    // garbled bytes and closes the tab — better than silently doing
    // nothing on click.
    return "unknown";
}

export function isImageExtension(ext: string): boolean {
    return IMAGE_EXTS.has(ext.toLowerCase());
}

export function isTextExtension(ext: string): boolean {
    return TEXT_EXTS.has(ext.toLowerCase());
}

export function isExternalExtension(ext: string): boolean {
    return EXTERNAL_EXTS.has(ext.toLowerCase());
}

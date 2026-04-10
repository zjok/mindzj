/**
 * Filename display helpers.
 *
 * The user-facing convention is: strip the `.md` and `.mindzj` suffixes
 * from files in every piece of UI (tabs, file tree, search results,
 * outline, backlinks, command palette, etc.) while keeping the real
 * filename on disk so Windows Explorer still shows `foo.md` / `foo.mindzj`.
 *
 * Other extensions (images, PDFs, etc.) are shown as-is so the user can
 * distinguish them at a glance.
 */

/** Extension suffixes (including the leading dot) that the UI hides. */
const HIDDEN_SUFFIXES = [".md", ".mindzj"];

/** Extract just the file name part from a vault-relative path. */
export function baseName(path: string): string {
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
}

/**
 * Display name for a file path — strips hidden extensions from the end of
 * the base name but leaves all other extensions intact. Use this in every
 * UI component that renders a filename for human consumption.
 */
export function displayName(path: string): string {
    const name = baseName(path);
    const lower = name.toLowerCase();
    for (const suffix of HIDDEN_SUFFIXES) {
        if (lower.endsWith(suffix)) {
            return name.slice(0, -suffix.length);
        }
    }
    return name;
}

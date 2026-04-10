/**
 * Utilities for keeping wiki-link references in sync when files or
 * headings are renamed.
 *
 * - `updateBacklinksOnFileRename` — after a file rename, rewrites
 *   every `[[oldName…]]` occurrence in other files.
 * - `updateBacklinksOnHeadingRename` — after a heading rename, rewrites
 *   every `[[…#oldHeading…]]` occurrence in other files (and same-file
 *   `[[#heading]]` references).
 */

import { invoke } from "@tauri-apps/api/core";

// Must match the Rust NoteLink struct shape
interface NoteLink {
    source: string;
    target: string;
    display_text: string | null;
    link_type: string;
    line: number;
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── File rename ─────────────────────────────────────────────────────

/**
 * Rewrite wiki links that point to `oldPath` so they point to `newPath`.
 *
 * IMPORTANT: call this **before** `invoke("rename_file", …)` — the
 * backend removes backlink entries for the old path during rename, so
 * we must snapshot them first.
 */
export async function updateBacklinksOnFileRename(
    oldPath: string,
    newPath: string,
    /** Pre-fetched backlinks (must be obtained before the rename) */
    backlinks: NoteLink[],
): Promise<void> {
    const oldName = oldPath.replace(/\.md$/, "");
    const newName = newPath.replace(/\.md$/, "");
    if (oldName === newName) return;

    const sourceFiles = [...new Set(backlinks.map((l) => l.source))];

    for (const sourcePath of sourceFiles) {
        try {
            const file = await invoke<{ content: string }>("read_file", {
                relativePath: sourcePath,
            });
            // [[oldName]]  [[oldName#h]]  [[oldName|d]]
            const re = new RegExp(
                `\\[\\[${escapeRegex(oldName)}([\\]#|])`,
                "g",
            );
            const updated = file.content.replace(re, `[[${newName}$1`);
            if (updated !== file.content) {
                await invoke("write_file", {
                    relativePath: sourcePath,
                    content: updated,
                });
            }
        } catch {
            // Source file may have been deleted since the index was built
        }
    }
}

/**
 * Fetch backlinks for a path from the backend link index.
 * Must be called before the rename so the index still has the old path.
 */
export async function fetchBacklinks(path: string): Promise<NoteLink[]> {
    try {
        return await invoke<NoteLink[]>("get_backlinks", {
            relativePath: path,
        });
    } catch {
        return [];
    }
}

// ── Heading rename ──────────────────────────────────────────────────

/**
 * Rewrite `[[…#oldHeading…]]` references after a heading was renamed.
 */
export async function updateBacklinksOnHeadingRename(
    filePath: string,
    oldHeading: string,
    newHeading: string,
): Promise<void> {
    if (oldHeading === newHeading) return;
    const fileName = filePath.replace(/\.md$/, "");

    try {
        // Backlinks to this file (other files that link here)
        const backlinks = await invoke<NoteLink[]>("get_backlinks", {
            relativePath: filePath,
        });
        const sourceFiles = [...new Set(backlinks.map((l) => l.source))];
        // Also check the file itself for same-file #heading refs
        if (!sourceFiles.includes(filePath)) sourceFiles.push(filePath);

        const oldAnchor = escapeRegex(oldHeading);

        for (const sourcePath of sourceFiles) {
            try {
                const file = await invoke<{ content: string }>("read_file", {
                    relativePath: sourcePath,
                });
                let content = file.content;
                let changed = false;

                // [[fileName#oldHeading]]  [[fileName#oldHeading|d]]
                const full = new RegExp(
                    `\\[\\[${escapeRegex(fileName)}#${oldAnchor}([\\]|])`,
                    "g",
                );
                if (full.test(content)) {
                    content = content.replace(
                        full,
                        `[[${fileName}#${newHeading}$1`,
                    );
                    changed = true;
                }

                // Same-file references [[#oldHeading]]
                if (sourcePath === filePath) {
                    const same = new RegExp(
                        `\\[\\[#${oldAnchor}([\\]|])`,
                        "g",
                    );
                    if (same.test(content)) {
                        content = content.replace(
                            same,
                            `[[#${newHeading}$1`,
                        );
                        changed = true;
                    }
                }

                if (changed) {
                    await invoke("write_file", {
                        relativePath: sourcePath,
                        content,
                    });
                }
            } catch {
                // skip
            }
        }
    } catch (e) {
        console.error("Failed to update heading references:", e);
    }
}

// ── Heading diff helper ─────────────────────────────────────────────

/** Extract heading texts from markdown content. */
export function extractHeadings(content: string): string[] {
    const headings: string[] = [];
    for (const line of content.split("\n")) {
        const m = line.match(/^#{1,6}\s+(.+)$/);
        if (m) headings.push(m[1].trim());
    }
    return headings;
}

/**
 * Compare two heading lists and return `[oldText, newText]` pairs for
 * headings that were likely renamed (same position, text changed, old
 * text doesn't appear elsewhere in the new list).
 */
export function findRenamedHeadings(
    oldH: string[],
    newH: string[],
): Array<[string, string]> {
    const renamed: Array<[string, string]> = [];
    const newSet = new Set(newH);
    const min = Math.min(oldH.length, newH.length);
    const usedNew = new Set<string>();

    for (let i = 0; i < min; i++) {
        if (oldH[i] !== newH[i] && !newSet.has(oldH[i]) && !usedNew.has(newH[i])) {
            renamed.push([oldH[i], newH[i]]);
            usedNew.add(newH[i]);
        }
    }
    return renamed;
}

// ── Anchor text tracking (Ctrl+Alt+C/V marks) ──────────────────────

/**
 * Collect all `#anchor` texts that other files use to link to `filePath`.
 * Scans the source content of each backlink for `[[fileName#anchor…]]`.
 */
export async function collectReferencedAnchors(
    filePath: string,
): Promise<string[]> {
    const fileName = filePath.replace(/\.md$/, "");
    const anchors: string[] = [];
    try {
        const backlinks = await invoke<NoteLink[]>("get_backlinks", {
            relativePath: filePath,
        });
        const sources = [...new Set(backlinks.map((l) => l.source))];
        // Also check same-file refs
        if (!sources.includes(filePath)) sources.push(filePath);

        const re = new RegExp(
            `\\[\\[(?:${escapeRegex(fileName)})?#([^\\]|]+)`,
            "g",
        );
        for (const src of sources) {
            try {
                const f = await invoke<{ content: string }>("read_file", {
                    relativePath: src,
                });
                let m: RegExpExecArray | null;
                while ((m = re.exec(f.content)) !== null) {
                    const anchor = m[1].trim();
                    if (anchor && !anchors.includes(anchor)) anchors.push(anchor);
                }
                re.lastIndex = 0; // reset for next file
            } catch { /* skip */ }
        }
    } catch { /* skip */ }
    return anchors;
}

/**
 * Given the old list of anchors that were referenced and the new file
 * content, find anchors that no longer exist and try to match them to
 * a changed line.  Returns `[oldAnchor, newText]` pairs.
 */
export function findRenamedAnchors(
    oldAnchors: string[],
    oldContent: string,
    newContent: string,
): Array<[string, string]> {
    const newLines = newContent.split("\n").map((l) => l.trim());
    const newLineSet = new Set(newLines);
    const oldLines = oldContent.split("\n").map((l) => l.trim());
    const renamed: Array<[string, string]> = [];

    for (const anchor of oldAnchors) {
        const lowerAnchor = anchor.toLowerCase();

        // Check if anchor still exists (heading or line text)
        const stillExists = newLines.some((l) => {
            const lt = l.toLowerCase();
            // heading match
            const hm = l.match(/^#{1,6}\s+(.+)$/);
            if (hm && hm[1].trim().toLowerCase() === lowerAnchor) return true;
            // exact line match
            if (lt === lowerAnchor) return true;
            return false;
        });
        if (stillExists) continue;

        // Anchor is missing — try to find the old line's index and see
        // if the line at the same position changed.
        const oldIdx = oldLines.findIndex((l) => {
            const lt = l.toLowerCase();
            const hm = l.match(/^#{1,6}\s+(.+)$/);
            if (hm && hm[1].trim().toLowerCase() === lowerAnchor) return true;
            if (lt === lowerAnchor) return true;
            return false;
        });
        if (oldIdx < 0 || oldIdx >= newLines.length) continue;

        const candidate = newLines[oldIdx];
        if (!candidate || candidate === "" || newLineSet.has(anchor)) continue;

        // Extract heading text or use full line
        const hm = candidate.match(/^#{1,6}\s+(.+)$/);
        const newText = hm ? hm[1].trim() : candidate;
        if (newText && newText !== anchor) {
            renamed.push([anchor, newText]);
        }
    }
    return renamed;
}

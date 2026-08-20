import { editorStore, type ViewMode } from "../stores/editor";
import { vaultStore } from "../stores/vault";
import { openFileRouted } from "./openFileRouted";

export interface WikiTarget {
    path: string;
    anchor: string | null;
}

export function parseWikiTarget(target: string): WikiTarget {
    const trimmed = target.trim();
    const hashIndex = trimmed.indexOf("#");
    let path = (hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed).trim();
    const anchor =
        hashIndex >= 0 ? trimmed.slice(hashIndex + 1).trim() || null : null;

    if (path && !/\.[^/\\.]+$/.test(path)) path += ".md";
    return { path, anchor };
}

function normalizeAnchor(value: string): string {
    return value
        .trim()
        .replace(/^#+\s*/, "")
        .replace(/[`*_~]/g, "")
        .replace(/\\([\\`*_{}\[\]()#+\-.!])/g, "$1")
        .replace(/\s+/g, " ")
        .toLocaleLowerCase();
}

export function findMarkdownAnchorLine(content: string, anchor: string): number | null {
    const wanted = normalizeAnchor(anchor);
    if (!wanted) return null;
    const wantedSlug = wanted.replace(/\s+/g, "-");
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
        if (!match) continue;
        const heading = normalizeAnchor(match[1]);
        if (heading === wanted || heading.replace(/\s+/g, "-") === wantedSlug) {
            return index;
        }
    }

    for (let index = 0; index < lines.length; index += 1) {
        if (normalizeAnchor(lines[index]) === wanted) return index;
    }
    return null;
}

export function revealFileLocation(
    path: string,
    line: number,
    column = 0,
): void {
    let retries = 24;
    const tryReveal = () => {
        let handled = false;
        document.dispatchEvent(
            new CustomEvent("mindzj:editor-command", {
                detail: {
                    command: "goto-line",
                    path,
                    line,
                    column,
                    handled: () => {
                        handled = true;
                    },
                },
            }),
        );
        if (!handled && retries-- > 0) window.setTimeout(tryReveal, 50);
    };
    window.setTimeout(tryReveal, 0);
}

export async function navigateWikiTarget(
    rawTarget: string,
    options?: { viewMode?: ViewMode },
): Promise<void> {
    const { path, anchor } = parseWikiTarget(rawTarget);
    if (path) {
        await openFileRouted(path);
        if (options?.viewMode) editorStore.setViewMode(options.viewMode, path);
    }
    if (!anchor) return;

    const targetPath = path || vaultStore.activeFile()?.path || "";
    const file = vaultStore.openFiles().find((entry) => entry.path === targetPath);
    const line = file ? findMarkdownAnchorLine(file.content, anchor) : null;
    if (targetPath && line !== null) revealFileLocation(targetPath, line);
}

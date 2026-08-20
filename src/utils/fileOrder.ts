export type FileOrderDropPosition = "before" | "after";

/**
 * Reorder against the exact sequence currently visible in the file tree.
 * This deliberately does not re-sort names: default order is produced by the
 * backend, and re-sorting here would make unrelated folders jump on first drag.
 */
export function reorderVisibleNames(
    visibleNames: string[],
    sourceName: string,
    targetName: string,
    position: FileOrderDropPosition,
): string[] {
    const next = visibleNames.filter((name) => name !== sourceName);
    const targetIndex = next.indexOf(targetName);
    if (targetIndex < 0) {
        next.push(sourceName);
        return next;
    }
    next.splice(targetIndex + (position === "after" ? 1 : 0), 0, sourceName);
    return next;
}

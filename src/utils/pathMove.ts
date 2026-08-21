/** Return the path after moving one file, or a directory and its descendants. */
export function remapMovedPath(
  path: string,
  from: string,
  to: string,
  recursive = false,
): string {
  if (path === from) return to;
  if (recursive && path.startsWith(`${from}/`)) {
    return `${to}${path.slice(from.length)}`;
  }
  return path;
}

/**
 * Remap open-file paths while keeping at most one tab for every final path.
 * If a stale destination tab already exists, the moved source tab wins so its
 * current in-memory content is preserved.
 */
export function remapUniquePathItems<T extends { path: string }>(
  items: readonly T[],
  from: string,
  to: string,
  recursive = false,
): T[] {
  const candidates = items.map((item) => {
    const path = remapMovedPath(item.path, from, to, recursive);
    return {
      item: path === item.path ? item : { ...item, path },
      moved: path !== item.path,
    };
  });
  const winnerByPath = new Map<string, number>();

  candidates.forEach((candidate, index) => {
    const currentWinner = winnerByPath.get(candidate.item.path);
    if (
      currentWinner == null ||
      (candidate.moved && !candidates[currentWinner]!.moved)
    ) {
      winnerByPath.set(candidate.item.path, index);
    }
  });

  return candidates
    .filter((candidate, index) => winnerByPath.get(candidate.item.path) === index)
    .map((candidate) => candidate.item);
}
